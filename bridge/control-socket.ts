// Local-only control socket for the warm bridge.
//
// The daemon owns the single warm ACP session; this hub lets local observers
// watch it. The daemon emits turn events (prompt in, streamed chunks as Jackie
// thinks, final reply, status); observer clients connect over a Unix socket and
// render them live — the attach experience Cursor doesn't give you out of the box.
//
// Read-only in Phase 1: `onLine` is reserved for Phase 2 (steer — inject a local
// prompt into the same serial queue). The socket is mode 0600 in the state dir
// and never bound to the network, so it's a local trust boundary only.

import { createServer, type Server, type Socket } from 'net'
import { appendFileSync, chmodSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { CONTROL_SOCK, STATE_DIR, TURNS_LOG } from '../shared/paths.js'

export type TurnEventInput =
  | { type: 'prompt'; source: 'discord' | 'local'; user?: string; channel?: string; text: string }
  | { type: 'chunk'; text: string }
  | { type: 'reply'; text: string; files?: string[] }
  | { type: 'status'; msg: string }
  // Unseen session/update subtypes — Phase 1 discovery (does ACP surface tool calls?).
  | { type: 'update'; subtype: string; raw?: unknown }

export type TurnEvent = TurnEventInput & { ts: number }

export type ControlServer = {
  broadcast: (ev: TurnEventInput) => void
  close: () => void
}

export function startControlServer(
  opts: { onLine?: (line: string, sock: Socket) => void } = {},
): ControlServer {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  // Remove a stale socket from a prior run; listen() fails on EADDRINUSE otherwise.
  if (existsSync(CONTROL_SOCK)) {
    try { unlinkSync(CONTROL_SOCK) } catch { /* nothing listening; will recreate */ }
  }

  const clients = new Set<Socket>()
  const server: Server = createServer((sock) => {
    clients.add(sock)
    sock.on('close', () => clients.delete(sock))
    sock.on('error', () => clients.delete(sock))
    if (opts.onLine) {
      let buf = ''
      sock.on('data', (b: Buffer) => {
        buf += b.toString()
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line) opts.onLine!(line, sock)
        }
      })
    }
  })
  server.on('error', (e) => process.stderr.write(`control: server error: ${e.message}\n`))
  server.listen(CONTROL_SOCK, () => {
    try { chmodSync(CONTROL_SOCK, 0o600) } catch { /* best effort */ }
    process.stderr.write(`control: observe socket at ${CONTROL_SOCK}\n`)
  })

  function broadcast(ev: TurnEventInput): void {
    const line = JSON.stringify({ ...ev, ts: Date.now() }) + '\n'
    try { appendFileSync(TURNS_LOG, line) } catch { /* log is best-effort */ }
    for (const c of clients) {
      try { c.write(line) } catch { clients.delete(c) }
    }
  }

  return {
    broadcast,
    close: () => {
      for (const c of clients) { try { c.destroy() } catch { /* already gone */ } }
      server.close()
      try { if (existsSync(CONTROL_SOCK)) unlinkSync(CONTROL_SOCK) } catch { /* already gone */ }
    },
  }
}
