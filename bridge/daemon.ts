#!/usr/bin/env tsx
/**
 * Cursor Discord bridge — inbound gateway.
 * Discord message → access gate → cursor agent -p → bridge posts reply (default).
 * Set CDC_BRIDGE_OUTBOUND=mcp for legacy agent-side Discord MCP replies.
 */

import { Client, GatewayIntentBits, Partials, type Message } from 'discord.js'
import {
  loadAccess,
  reconcileTrustedBots,
  startApprovalPoller,
} from '../shared/access.js'
import { loadStateEnv } from '../shared/env.js'
import { buildAgentPrompt, extractBridgeReply, formatChannelBlock } from '../shared/format-inbound.js'
import { gate } from '../shared/gate.js'
import { ENV_FILE } from '../shared/paths.js'
import { ensureCursorSubscriptionAuth } from './auth.js'
import { AcpSession } from './acp-client.js'
import { runCursorAgent } from './run-agent.js'

loadStateEnv()
reconcileTrustedBots()
ensureCursorSubscriptionAuth()

const TOKEN = process.env.DISCORD_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(`bridge: DISCORD_BOT_TOKEN required (set in ${ENV_FILE})\n`)
  process.exit(1)
}

const CWD = process.env.CURSOR_CWD ?? process.cwd()

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

let busy = false
const queue: Message[] = []

// Watchdog: agent runs are drained serially, so a single hung run (SIGTERM'd
// at the timeout) blocks every channel. The process stays alive, so systemd's
// Restart=always never fires and the bot goes silently dead. Count consecutive
// timeouts and self-exit once they cross the threshold — systemd then restarts
// the unit fresh (re-running ExecStartPre MCP sync + auth), clearing the wedge.
const MAX_CONSECUTIVE_TIMEOUTS = Number(process.env.CDC_MAX_CONSECUTIVE_TIMEOUTS ?? 2)
let consecutiveTimeouts = 0

// Warm path: instead of a cold `cursor-agent -p` per message, hold ONE shared
// `cursor-agent acp` session alive and prompt it each turn (~7x faster after the
// first turn, shared cross-channel memory). Gated behind CDC_AGENT_MODE=acp so
// the cold path stays the default until this is proven in production. The session
// is lazy + self-healing: if the acp process dies, the next message respawns it.
const ACP_MODE = process.env.CDC_AGENT_MODE === 'acp'
const ACP_PROMPT_TIMEOUT_MS = Number(process.env.CURSOR_AGENT_TIMEOUT_MS ?? 1_200_000)
let acp: AcpSession | null = null

function getAcp(): AcpSession {
  if (!acp) {
    process.stderr.write('bridge: starting warm cursor-agent acp session\n')
    acp = new AcpSession({ cwd: CWD, promptTimeoutMs: ACP_PROMPT_TIMEOUT_MS })
  }
  return acp
}

async function fetchTextChannel(id: string) {
  const ch = await client.channels.fetch(id)
  if (!ch?.isTextBased()) throw new Error(`channel ${id} not text-based`)
  return ch
}

startApprovalPoller(async (channelId, text) => {
  const ch = await fetchTextChannel(channelId)
  if ('send' in ch) await ch.send(text)
})

// Post a reply without dumping into a main-channel feed. The bridge (not the
// agent) decides where the reply lands, so this is the only place that can keep
// replies in threads. If the inbound message is already in a thread, reply
// there. If it arrived in a parent channel, reply inside that message's thread,
// creating one if needed — that's what stops the bot replying in the channel
// feed when it's @-mentioned on a top-level message (e.g. a PR announcement).
function replyThreadName(msg: Message): string {
  const base = (msg.content || '').replace(/<@!?\d+>/g, '').trim()
  return (base ? base.slice(0, 80) : `${msg.author.username} thread`) || 'thread'
}

async function postReply(msg: Message, text: string): Promise<void> {
  if (msg.channel?.isThread?.()) {
    await msg.reply(text)
    return
  }
  let thread = msg.thread ?? null
  if (!thread) {
    try {
      thread = await msg.startThread({ name: replyThreadName(msg), autoArchiveDuration: 1440 })
    } catch (err) {
      // A thread may already exist but be uncached, so startThread throws
      // ("already has a thread"). Re-fetch the message to resolve it instead
      // of silently dumping the reply into the channel feed.
      try {
        const fresh = await msg.fetch()
        thread = fresh.thread ?? null
      } catch {
        thread = null
      }
      if (!thread) {
        process.stderr.write(
          `bridge: postReply could not open a thread (${err instanceof Error ? err.message : String(err)}); replying in channel\n`,
        )
      }
    }
  }
  if (thread) await thread.send(text)
  else await msg.reply(text)
}

// Warm-session variant of the agent run. Prompts the shared ACP session and
// posts the assembled reply. Mirrors the cold path's watchdog (consecutive
// timeouts self-exit for a systemd restart) and adds session respawn: if the
// acp process has died, drop our handle so the next message starts a fresh one.
async function processViaAcp(msg: Message, prompt: string): Promise<void> {
  const started = Date.now()
  try {
    const raw = await getAcp().prompt(prompt)
    consecutiveTimeouts = 0
    process.stderr.write(`bridge: acp turn done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
    const text = extractBridgeReply(raw)
    if (!text) {
      process.stderr.write('bridge: acp returned empty reply; no Discord post\n')
      return
    }
    await postReply(msg, text.slice(0, 2000)).catch(err => {
      process.stderr.write(`bridge: reply failed: ${err instanceof Error ? err.message : String(err)}\n`)
    })
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    const died = /acp exited/i.test(text)
    if (died) {
      acp = null // force respawn on next message
      process.stderr.write(`bridge: acp session died (${text}); will respawn\n`)
      await postReply(msg, 'Agent restarted. Resend that and it should answer.').catch(() => {})
      return
    }
    // Treat a prompt timeout like the cold path: count it, warn, self-exit at threshold.
    consecutiveTimeouts++
    process.stderr.write(
      `bridge: acp prompt failed (${consecutiveTimeouts}/${MAX_CONSECUTIVE_TIMEOUTS} consecutive): ${text}\n`,
    )
    await postReply(msg, 'Agent timed out. Restarting if this keeps happening.').catch(() => {})
    if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
      process.stderr.write(`bridge: ${consecutiveTimeouts} consecutive acp failures — exiting for systemd restart\n`)
      acp?.destroy()
      client.destroy()
      process.exit(1)
    }
  }
}

async function processMessage(msg: Message): Promise<void> {
  const result = await gate(client, msg)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await msg.reply(
      `${lead} — run on the server:\n\n/discord:access pair ${result.code}`,
    )
    return
  }

  if ('sendTyping' in msg.channel) void msg.channel.sendTyping().catch(() => {})
  const ack = result.access.ackReaction ?? '👀'
  if (ack) void msg.react(ack).catch(() => {})

  const prompt = buildAgentPrompt(formatChannelBlock(msg))
  process.stderr.write(`bridge: agent run chat=${msg.channelId} user=${msg.author.username}\n`)

  if (ACP_MODE) {
    await processViaAcp(msg, prompt)
    return
  }

  const bridgeOutbound = process.env.CDC_BRIDGE_OUTBOUND !== 'mcp'

  try {
    const out = await runCursorAgent({ cwd: CWD, prompt, chatId: msg.channelId })
    if (out.timedOut) {
      consecutiveTimeouts++
      process.stderr.write(
        `bridge: agent run timed out (${consecutiveTimeouts}/${MAX_CONSECUTIVE_TIMEOUTS} consecutive)\n`,
      )
      await postReply(msg, 'Agent timed out. Restarting if this keeps happening.').catch(() => {})
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
        process.stderr.write(
          `bridge: ${consecutiveTimeouts} consecutive timeouts — exiting for systemd restart\n`,
        )
        client.destroy()
        process.exit(1)
      }
      return
    }
    consecutiveTimeouts = 0

    if (out.exitCode !== 0) {
      process.stderr.write(`bridge: agent exited ${out.exitCode}\n${out.stderr}\n`)
      await postReply(msg, `Agent error (exit ${out.exitCode}). Check bridge logs.`).catch(() => {})
      return
    }

    if (bridgeOutbound) {
      const text = extractBridgeReply(out.stdout)
      if (!text) {
        process.stderr.write('bridge: agent returned empty stdout; no Discord post\n')
        return
      }
      await postReply(msg, text.slice(0, 2000)).catch(err => {
        process.stderr.write(`bridge: reply failed: ${err instanceof Error ? err.message : String(err)}\n`)
      })
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    process.stderr.write(`bridge: agent spawn failed: ${text}\n`)
    await msg.reply(`Failed to start agent: ${text}`).catch(() => {})
  }
}

async function drainQueue(): Promise<void> {
  if (busy) return
  busy = true
  try {
    while (queue.length > 0) {
      const msg = queue.shift()!
      await processMessage(msg)
    }
  } finally {
    busy = false
  }
}

function enqueue(msg: Message): void {
  queue.push(msg)
  void drainQueue()
}

client.on('messageCreate', msg => {
  if (msg.author.id === client.user?.id) return
  if (msg.author.bot) {
    const trusted = loadAccess().trustedBots ?? []
    if (!trusted.includes(msg.author.id)) return
  }
  enqueue(msg)
})

client.once('ready', c => {
  process.stderr.write(`bridge: connected as ${c.user.tag}, cwd=${CWD}\n`)
})

client.on('error', e => {
  process.stderr.write(`bridge: client error: ${e.message}\n`)
})

process.on('SIGINT', () => {
  client.destroy()
  process.exit(0)
})
process.on('SIGTERM', () => {
  client.destroy()
  process.exit(0)
})

await client.login(TOKEN)
