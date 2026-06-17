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
import { existsSync, realpathSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { ensureCursorSubscriptionAuth } from './auth.js'
import { AcpSession } from './acp-client.js'
import { runCursorAgent } from './run-agent.js'
import { startControlServer } from './control-socket.js'

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
const queue: InboundTurn[] = []

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

// Local control socket: broadcast every turn (prompt in, streamed chunks, reply,
// status) so `connect jackie` can watch the warm session live, AND accept local
// "inject" lines so Lily can steer by typing into the same serial queue Discord
// uses (shared warm-session context). Local-only, 0600 — see control-socket.ts.
const control = startControlServer({
  onLine: (line) => {
    try {
      const m = JSON.parse(line)
      // enqueue is a hoisted function declaration; safe to reference here.
      if (m && m.type === 'inject' && typeof m.text === 'string' && m.text.trim()) {
        enqueue({ kind: 'local', text: m.text.trim() })
      }
    } catch { /* ignore malformed control input */ }
  },
})

function getAcp(): AcpSession {
  if (!acp) {
    process.stderr.write('bridge: starting warm cursor-agent acp session\n')
    acp = new AcpSession({
      cwd: CWD,
      promptTimeoutMs: ACP_PROMPT_TIMEOUT_MS,
      onChunk: (text) => control.broadcast({ type: 'chunk', text }),
      onUpdate: (subtype, update) => control.broadcast({ type: 'update', subtype, raw: update }),
    })
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

// Agents reply with plain text; the bridge posts it. To send a file (an image,
// a rendered diagram), an agent adds a line `ATTACH: /abs/path` (one per file).
// We strip those lines and upload the files alongside the remaining text. Paths
// must be absolute and exist; oversized/missing ones are dropped with a log so a
// bad path never blocks the text reply.
const MAX_ATTACH_BYTES = 24 * 1024 * 1024 // Discord's non-Nitro upload ceiling

// ATTACH paths come from agent output that is driven by (untrusted) inbound
// messages, so a prompt-injected `ATTACH: /home/.../.env` must not exfiltrate
// secrets. Confine uploads to a few safe roots: render output in the temp dir and
// the agent's own workspace. Symlinks are resolved (realpath) before the check so
// a symlink inside an allowed root can't escape it. Override with CDC_ATTACH_ROOTS
// (colon-separated).
const ATTACH_ROOTS = (process.env.CDC_ATTACH_ROOTS ?? `/tmp:${tmpdir()}:${CWD}`)
  .split(':').filter(Boolean).map(r => resolve(r))

function attachPathAllowed(realPath: string): boolean {
  return ATTACH_ROOTS.some(root => realPath === root || realPath.startsWith(root + '/'))
}

function extractAttachments(text: string): { text: string; files: string[] } {
  const files: string[] = []
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*ATTACH:\s*(\/\S.*?)\s*$/i.exec(line)
    if (!m) { kept.push(line); continue }
    const p = m[1]
    try {
      if (!existsSync(p)) { process.stderr.write(`bridge: ATTACH dropped (missing): ${p}\n`); continue }
      const real = realpathSync(p)
      if (!attachPathAllowed(real)) { process.stderr.write(`bridge: ATTACH dropped (outside allowed roots): ${p}\n`); continue }
      if (statSync(real).size > MAX_ATTACH_BYTES) { process.stderr.write(`bridge: ATTACH dropped (>24MB): ${p}\n`); continue }
      files.push(real)
    } catch {
      process.stderr.write(`bridge: ATTACH dropped (resolve/stat failed): ${p}\n`)
    }
  }
  return { text: kept.join('\n').trim(), files }
}

type ReplyPayload = string | { content?: string; files: string[] }
function buildPayload(text: string, files: string[]): ReplyPayload {
  // discord.js rejects an empty content string, so omit it when sending files only.
  return files.length ? { content: text || undefined, files } : text
}

async function postReply(msg: Message, text: string, files: string[] = []): Promise<void> {
  const payload = buildPayload(text, files)
  if (msg.channel?.isThread?.()) {
    await msg.reply(payload)
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
  if (thread) await thread.send(payload)
  else await msg.reply(payload)
}

// How a turn's reply is delivered. A Discord turn posts to its thread; a local
// steer turn no-ops (the observer already shows the streamed reply live).
type Deliver = (text: string, files?: string[]) => Promise<void>

// An inbound turn for the shared serial queue: a Discord message, or a local
// "steer" message Lily typed into the observe socket. Both run through the SAME
// warm session, one at a time (chunkBuf is shared — see acp-client prompt()).
type InboundTurn = { kind: 'discord'; msg: Message } | { kind: 'local'; text: string }

// Run one turn through the shared warm ACP session and route its reply via
// `deliver`. Mirrors the cold path's watchdog (consecutive timeouts self-exit for
// a systemd restart) and respawns a dead acp session on the next message.
async function runAcpTurn(prompt: string, deliver: Deliver): Promise<void> {
  const started = Date.now()
  try {
    const raw = await getAcp().prompt(prompt)
    consecutiveTimeouts = 0
    process.stderr.write(`bridge: acp turn done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
    const { text, files } = extractAttachments(extractBridgeReply(raw))
    if (!text && !files.length) {
      process.stderr.write('bridge: acp returned empty reply\n')
      return
    }
    if (files.length) process.stderr.write(`bridge: attaching ${files.length} file(s)\n`)
    control.broadcast({ type: 'reply', text, files })
    await deliver(text.slice(0, 2000), files).catch(err => {
      process.stderr.write(`bridge: reply failed: ${err instanceof Error ? err.message : String(err)}\n`)
    })
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    const died = /acp exited/i.test(text)
    if (died) {
      acp = null // force respawn on next message
      process.stderr.write(`bridge: acp session died (${text}); will respawn\n`)
      control.broadcast({ type: 'status', msg: 'acp session died; will respawn on next message' })
      await deliver('Agent restarted. Resend that and it should answer.').catch(() => {})
      return
    }
    // Treat a prompt timeout like the cold path: count it, warn, self-exit at threshold.
    consecutiveTimeouts++
    process.stderr.write(
      `bridge: acp prompt failed (${consecutiveTimeouts}/${MAX_CONSECUTIVE_TIMEOUTS} consecutive): ${text}\n`,
    )
    // Only speak up when we're actually restarting. A single isolated timeout
    // (followed by a successful run) is normal for a long, high-context task —
    // posting "Agent timed out" on every one of those just spams the channel.
    if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
      process.stderr.write(`bridge: ${consecutiveTimeouts} consecutive acp failures — exiting for systemd restart\n`)
      control.broadcast({ type: 'status', msg: 'consecutive timeouts — restarting bridge' })
      await deliver('Agent kept timing out. Restarting.').catch(() => {})
      acp?.destroy()
      control.close()
      client.destroy()
      process.exit(1)
    }
  }
}

// Cold path (one `cursor-agent -p` per turn). Default until ACP is proven; kept
// deliver-based so a local steer turn can run here too.
async function runColdTurn(prompt: string, chatId: string, deliver: Deliver): Promise<void> {
  try {
    const out = await runCursorAgent({ cwd: CWD, prompt, chatId })
    if (out.timedOut) {
      consecutiveTimeouts++
      process.stderr.write(
        `bridge: agent run timed out (${consecutiveTimeouts}/${MAX_CONSECUTIVE_TIMEOUTS} consecutive)\n`,
      )
      // Only speak up when we're actually restarting. A single isolated timeout
      // (followed by a successful run) is normal for a long, high-context task —
      // posting "Agent timed out" on every one of those just spams the channel.
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
        process.stderr.write(
          `bridge: ${consecutiveTimeouts} consecutive timeouts — exiting for systemd restart\n`,
        )
        control.broadcast({ type: 'status', msg: 'consecutive timeouts — restarting bridge' })
        await deliver('Agent kept timing out. Restarting.').catch(() => {})
        control.close()
        client.destroy()
        process.exit(1)
      }
      return
    }
    consecutiveTimeouts = 0

    if (out.exitCode !== 0) {
      process.stderr.write(`bridge: agent exited ${out.exitCode}\n${out.stderr}\n`)
      await deliver(`Agent error (exit ${out.exitCode}). Check bridge logs.`).catch(() => {})
      return
    }

    if (process.env.CDC_BRIDGE_OUTBOUND !== 'mcp') {
      const { text, files } = extractAttachments(extractBridgeReply(out.stdout))
      if (!text && !files.length) {
        process.stderr.write('bridge: agent returned empty stdout\n')
        return
      }
      if (files.length) process.stderr.write(`bridge: attaching ${files.length} file(s)\n`)
      control.broadcast({ type: 'reply', text, files })
      await deliver(text.slice(0, 2000), files).catch(err => {
        process.stderr.write(`bridge: reply failed: ${err instanceof Error ? err.message : String(err)}\n`)
      })
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    process.stderr.write(`bridge: agent spawn failed: ${text}\n`)
    await deliver(`Failed to start agent: ${text}`).catch(() => {})
  }
}

async function processTurn(turn: InboundTurn): Promise<void> {
  // Local steer: send Lily's message RAW into the warm session (no wrapper — she's
  // talking to Jackie directly, like attaching to Bill). The reply streams to her
  // viewer via the broadcast; we don't post it to Discord.
  if (turn.kind === 'local') {
    process.stderr.write(`bridge: local steer turn (${turn.text.length} chars)\n`)
    control.broadcast({ type: 'prompt', source: 'local', user: 'lily', text: turn.text })
    const deliver: Deliver = async () => {}
    if (ACP_MODE) await runAcpTurn(turn.text, deliver)
    else await runColdTurn(turn.text, 'local', deliver)
    return
  }

  const msg = turn.msg
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
  control.broadcast({
    type: 'prompt',
    source: 'discord',
    user: msg.author.username,
    channel: msg.channelId,
    text: (msg.content || '').replace(/<@!?\d+>/g, '').trim(),
  })

  const deliver: Deliver = (text, files = []) => postReply(msg, text, files)
  if (ACP_MODE) await runAcpTurn(prompt, deliver)
  else await runColdTurn(prompt, msg.channelId, deliver)
}

async function drainQueue(): Promise<void> {
  if (busy) return
  busy = true
  try {
    while (queue.length > 0) {
      const turn = queue.shift()!
      await processTurn(turn)
    }
  } finally {
    busy = false
  }
}

function enqueue(turn: InboundTurn): void {
  queue.push(turn)
  void drainQueue()
}

client.on('messageCreate', msg => {
  if (msg.author.id === client.user?.id) return
  if (msg.author.bot) {
    const trusted = loadAccess().trustedBots ?? []
    if (!trusted.includes(msg.author.id)) return
  }
  enqueue({ kind: 'discord', msg })
})

client.once('ready', c => {
  process.stderr.write(`bridge: connected as ${c.user.tag}, cwd=${CWD}\n`)
})

client.on('error', e => {
  process.stderr.write(`bridge: client error: ${e.message}\n`)
})

process.on('SIGINT', () => {
  control.close()
  client.destroy()
  process.exit(0)
})
process.on('SIGTERM', () => {
  control.close()
  client.destroy()
  process.exit(0)
})

await client.login(TOKEN)
