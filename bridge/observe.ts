#!/usr/bin/env tsx
// Watch and talk to the warm bridge live.
//
// Connects to the daemon's local control socket and renders each turn as it
// happens: the inbound prompt, Jackie's reply streaming token-by-token, any tool
// /file updates ACP surfaces, and status (timeouts, restarts). Type a line and
// hit enter to message Jackie directly — it goes into the SAME warm session
// Discord uses (shared context), and his reply streams right back here. Just like
// attaching to a Claude Code agent.
//
// Ctrl-C quits the VIEWER only; Jackie is a separate process and keeps running.
// (Inside tmux you can also detach with Ctrl-b then d.)

import { connect, type Socket } from 'net'
import { createInterface } from 'readline'
import { CONTROL_SOCK } from '../shared/paths.js'

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

function hhmmss(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// Track whether the cursor is at the start of a line, so block elements (prompt
// header, status) never glue onto a half-streamed reply line.
let atLineStart = true
let sawChunk = false // did this turn stream any text? (cold path streams none)

function out(s: string): void {
  try {
    process.stdout.write(s)
  } catch {
    process.exit(0) // terminal/pipe closed — nothing to view anymore
  }
  if (s.length) atLineStart = s.endsWith('\n')
}
// If the consumer of our stdout goes away (terminal closed), exit quietly
// instead of crashing on EPIPE.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0)
})
function newlineIfNeeded(): void {
  if (!atLineStart) out('\n')
}

function render(ev: any): void {
  switch (ev.type) {
    case 'prompt': {
      newlineIfNeeded()
      sawChunk = false
      const who = `${ev.source}/${ev.user ?? '?'}`
      const chan = ev.channel ? C.dim(` #${ev.channel}`) : ''
      out('\n' + C.dim(`┌─ ${hhmmss(ev.ts)} `) + C.cyan(C.bold(who)) + chan + '\n')
      out(C.cyan('│ ') + (ev.text || C.dim('(no text)')).replace(/\n/g, '\n' + C.cyan('│ ')) + '\n')
      out(C.dim('└─ ') + C.green(C.bold('jackie')) + C.dim(' ▸ '))
      break
    }
    case 'chunk': {
      sawChunk = true
      out(C.green(ev.text))
      break
    }
    case 'reply': {
      // ACP streamed the text already via chunks; just finalize. Cold path sends
      // no chunks, so print the full reply text here.
      if (!sawChunk && ev.text) out(C.green(ev.text))
      newlineIfNeeded()
      if (ev.files?.length) out(C.dim(`   📎 ${ev.files.length} file(s): ${ev.files.join(', ')}\n`))
      break
    }
    case 'update': {
      newlineIfNeeded()
      const detail = summarizeUpdate(ev.raw)
      out(C.magenta(`  · ${ev.subtype}`) + (detail ? C.dim(` ${detail}`) : '') + '\n')
      break
    }
    case 'status': {
      newlineIfNeeded()
      out(C.yellow(`  ⚠ ${ev.msg}`) + '\n')
      break
    }
  }
}

// Best-effort one-liner for a non-chunk session/update (tool call, plan, etc.).
// We don't know the exact shapes yet (Phase 1 discovery), so pull common fields
// and otherwise show a short JSON snippet.
function summarizeUpdate(raw: any): string {
  if (!raw || typeof raw !== 'object') return ''
  const name = raw.title ?? raw.name ?? raw.toolName ?? raw.kind
  if (name) return String(name).slice(0, 120)
  try {
    const s = JSON.stringify(raw)
    return s.length > 120 ? s.slice(0, 117) + '...' : s
  } catch {
    return ''
  }
}

// The live socket, so the stdin reader can inject typed messages into it.
let current: Socket | null = null
let retrying = false
// Lines typed before the socket is connected (or during a reconnect) wait here
// and flush on connect, so a fast first message is never dropped.
const pending: string[] = []
function sendInject(text: string): void {
  const line = JSON.stringify({ type: 'inject', text }) + '\n'
  try { current!.write(line) } catch { out(C.dim('— send failed —\n')) }
}
function start(): void {
  let buf = ''
  retrying = false
  const sock: Socket = connect(CONTROL_SOCK)
  sock.on('connect', () => {
    current = sock
    out(C.dim(`— connected to ${CONTROL_SOCK} — watching Jackie. Type a message + enter to talk to him. Ctrl-C to quit. —\n`))
    while (pending.length) sendInject(pending.shift()!)
  })
  sock.on('data', (b: Buffer) => {
    buf += b.toString()
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try { render(JSON.parse(line)) } catch { /* ignore malformed */ }
    }
  })
  const retry = () => {
    current = null
    if (retrying) return // 'error' and 'close' both fire; reconnect once
    retrying = true
    newlineIfNeeded()
    out(C.dim('— bridge not reachable; retrying in 2s —\n'))
    setTimeout(start, 2000)
  }
  sock.on('error', retry)
  sock.on('close', retry)
}

start()

// Type a line + enter to message Jackie. Sent as an "inject" into the warm
// session's serial queue; his reply streams back via the broadcast above.
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  if (current && !current.destroyed) sendInject(text)
  else pending.push(text) // not connected yet — flush on connect
})

process.on('SIGINT', () => { process.stdout.write('\n'); process.exit(0) })
