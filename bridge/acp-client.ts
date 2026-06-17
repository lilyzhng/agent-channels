// A warm, shared Cursor Agent session over ACP (Agent Client Protocol).
//
// Why this exists: the bridge used to run `cursor-agent -p "<message>"` once per
// Discord message — a cold start (binary init + MCP handshake + context re-read)
// every time, ~10-12s on the droplet, with no memory across messages. Cursor
// officially exposes a persistent server: `cursor-agent acp` speaks ACP (JSON-RPC
// over stdio). This module spawns it once, opens ONE shared session, and exposes
// prompt(text) -> reply. The cold-start cost is paid once; subsequent turns are
// warm (~1.5s) and share a single coherent context — like Claude Code --channels.
//
// One shared session (not per-channel) is deliberate: Jackie is a long-running
// assistant who should remember everything across channels. The caller tags each
// prompt with its source (channel/thread/user) so the agent stays channel-aware.

import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'

export type AcpOptions = {
  bin?: string // path to the cursor-agent binary
  cwd: string // workspace the agent operates in
  promptTimeoutMs?: number
  // Live tap for local observers. onChunk fires per streamed agent_message_chunk
  // (the final assembled reply is unchanged). onUpdate fires for every OTHER
  // session/update subtype — Phase 1 discovery of what ACP surfaces (tool calls,
  // plans, file edits). Both are best-effort; throwing handlers must not break a turn.
  onChunk?: (text: string) => void
  onUpdate?: (subtype: string, update: unknown) => void
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void }

export class AcpSession {
  private proc: ChildProcess
  private nextId = 1
  private pending = new Map<number, Pending>()
  private sessionId: string | null = null
  private chunkBuf: string[] = []
  private ready: Promise<void>
  private promptTimeoutMs: number
  private onChunk?: (text: string) => void
  private onUpdate?: (subtype: string, update: unknown) => void

  constructor(opts: AcpOptions) {
    const bin = opts.bin ?? process.env.CDC_AGENT_BIN ?? 'cursor-agent'
    this.promptTimeoutMs = opts.promptTimeoutMs ?? 600_000
    this.onChunk = opts.onChunk
    this.onUpdate = opts.onUpdate
    this.proc = spawn(bin, ['acp'], {
      cwd: opts.cwd,
      env: { ...process.env, CURSOR_CWD: opts.cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    createInterface({ input: this.proc.stdout! }).on('line', (line) => this.onLine(line))
    this.proc.stderr?.on('data', (b: Buffer) => process.stderr.write(`acp: ${b}`))
    this.proc.on('exit', (code) => {
      const err = new Error(`cursor-agent acp exited (${code})`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })
    this.ready = this.init(opts.cwd)
  }

  private send(obj: unknown): void {
    this.proc.stdin!.write(JSON.stringify(obj) + '\n')
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`acp ${method} timed out`))
      }, timeoutMs ?? 60_000)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private onLine(line: string): void {
    line = line.trim()
    if (!line) return
    let m: any
    try { m = JSON.parse(line) } catch { return }
    if (m.id != null && (m.result !== undefined || m.error !== undefined)) {
      const p = this.pending.get(m.id)
      if (p) {
        this.pending.delete(m.id)
        m.error ? p.reject(m.error) : p.resolve(m.result)
      }
    } else if (m.method && m.id != null) {
      this.handleAgentRequest(m) // agent -> client request
    } else if (m.method === 'session/update') {
      const u = m.params?.update
      const sub: string | undefined = u?.sessionUpdate
      if (sub === 'agent_message_chunk') {
        const text = u.content?.text ?? ''
        this.chunkBuf.push(text)
        if (text) { try { this.onChunk?.(text) } catch { /* observer must not break a turn */ } }
      } else if (sub) {
        // Any non-chunk update (tool_call, plan, file edit, ...) — surface for observers.
        try { this.onUpdate?.(sub, u) } catch { /* best-effort */ }
      }
    }
  }

  // The agent can call back into the client mid-turn (permissions, fs). Keep the
  // turn moving: auto-allow permission prompts, no-op the rest. (Tightened later.)
  private handleAgentRequest(m: any): void {
    const meth: string = m.method
    if (meth.includes('request_permission')) {
      this.send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } })
    } else if (meth.startsWith('fs/')) {
      this.send({ jsonrpc: '2.0', id: m.id, result: { content: '' } })
    } else {
      this.send({ jsonrpc: '2.0', id: m.id, result: {} })
    }
  }

  private async init(cwd: string): Promise<void> {
    // We do not provide client-side fs or terminal: cursor-agent uses its own
    // file and shell tools (verified: it reads files and runs commands itself).
    // Advertise false so it never delegates an fs/* call to our no-op handler.
    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    const r = await this.request('session/new', { cwd, mcpServers: [] })
    this.sessionId = r.sessionId
  }

  /**
   * Send a prompt into the shared warm session; resolve with the assembled reply text.
   *
   * Correctness depends on serial execution: `chunkBuf` is a single shared buffer and
   * the streamed `agent_message_chunk` notifications carry no request id, so two
   * overlapping prompts would interleave into the same buffer. The daemon guarantees
   * this — `drainQueue` is `busy`-guarded and `await`s each `processMessage`, so only
   * one prompt() is ever in flight across all channels. Do not call this concurrently.
   */
  async prompt(text: string): Promise<string> {
    await this.ready
    this.chunkBuf = []
    await this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }, this.promptTimeoutMs)
    return this.chunkBuf.join('').trim()
  }

  destroy(): void {
    try { this.proc.kill('SIGTERM') } catch { /* already gone */ }
  }
}
