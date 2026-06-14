import type { Message } from 'discord.js'
import { mentionPromptBlock } from './mentions.js'

function safeAttName(name: string, id: string): string {
  return (name ?? id).replace(/[\[\]\r\n;]/g, '_')
}

export function formatChannelBlock(msg: Message): string {
  const atts: string[] = []
  for (const att of msg.attachments.values()) {
    const kb = (att.size / 1024).toFixed(0)
    atts.push(`${safeAttName(att.name ?? '', att.id)} (${att.contentType ?? 'unknown'}, ${kb}KB)`)
  }

  // Keep <@snowflake> — converting to @username trains agents to ping wrong.
  const content = msg.content.trim() || (atts.length > 0 ? '(attachment)' : '')
  const attAttrs =
    atts.length > 0
      ? ` attachment_count="${atts.length}" attachments="${atts.join('; ')}"`
      : ''

  return [
    `<channel source="discord" chat_id="${msg.channelId}" message_id="${msg.id}" user="${msg.author.username}" user_id="${msg.author.id}" ts="${msg.createdAt.toISOString()}"${attAttrs}>`,
    content,
    '</channel>',
  ].join('\n')
}

function bridgeOutboundPrompt(channelBlock: string): string {
  return [
    'You received a Discord message. The sender reads Discord, not this terminal.',
    'Do NOT use any Discord MCP or plugin tools (reply, edit_message, react, fetch_messages, etc.).',
    'Those tools post as the wrong bot when multiple Discord integrations are installed.',
    'Write your Discord reply as plain text in your response ONLY — the bridge posts it as this bot.',
    '',
    'One wake = one user-visible message: put the full answer in your text output (no tool calls for Discord).',
    'Do not apologize for prior turns; answer only the latest message.',
    '',
    'To attach a file (image, rendered diagram, etc.), add a line exactly like `ATTACH: /absolute/path` (one per file, max 24MB each).',
    'The bridge uploads each attached file to Discord and strips the ATTACH line from your message. The path must be absolute and already exist on disk.',
    '',
    mentionPromptBlock(),
    '',
    'To notify the sender, tag them with <@user_id> from the channel block or list above.',
    '',
    channelBlock,
  ].join('\n')
}

function mcpOutboundPrompt(channelBlock: string): string {
  return [
    'You received a Discord message. The sender reads Discord, not this terminal.',
    'You MUST reply using the discord `reply` tool with the chat_id from the channel block.',
    'Do not rely on stdout — only the reply tool reaches Discord.',
    '',
    'One wake = one user-visible Discord message (default): a single `reply` with the full answer.',
    'Only if work will take >30s: one short `reply`, then `edit_message` on that message — never a 2nd or 3rd `reply`.',
    'Do not apologize for prior turns; answer only the latest message.',
    '',
    mentionPromptBlock(),
    '',
    'To notify the sender, tag them with <@user_id> from the channel block or list above.',
    '',
    channelBlock,
  ].join('\n')
}

/** Bridge mode posts via the bridge Discord client (correct bot avatar). MCP mode uses agent reply tools. */
export function buildAgentPrompt(channelBlock: string): string {
  if (process.env.CDC_BRIDGE_OUTBOUND === 'mcp') return mcpOutboundPrompt(channelBlock)
  return bridgeOutboundPrompt(channelBlock)
}

/** Strip agent stdout to the user-visible Discord reply body. */
export function extractBridgeReply(stdout: string): string {
  const lines = stdout.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (/^(chat|session)[\s_-]*id[:\s]/i.test(line.trim())) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}
