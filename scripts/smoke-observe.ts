#!/usr/bin/env tsx
// Isolated smoke test for the local observe path (Phase 1). Touches NO production
// state: points CDC_STATE_DIR at a throwaway temp dir, starts a control server,
// runs observe.ts as a child against it, broadcasts a scripted turn, and asserts
// the viewer rendered the prompt, the streamed reply, a tool update, and status —
// plus that the NDJSON replay log captured every event.
//
//   tsx scripts/smoke-observe.ts   (exit 0 = pass, 1 = fail)

import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname, resolve } from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const stateDir = mkdtempSync(join(tmpdir(), 'cdc-smoke-'))
process.env.CDC_STATE_DIR = stateDir

const { startControlServer } = await import('../bridge/control-socket.js')
const { TURNS_LOG } = await import('../shared/paths.js')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fails: string[] = []
function check(cond: boolean, msg: string): void {
  if (!cond) fails.push(msg)
  process.stdout.write(`${cond ? 'ok  ' : 'FAIL'}  ${msg}\n`)
}

const server = startControlServer()
await sleep(150) // let the socket bind

// Run the real viewer against our throwaway socket; strip ANSI to assert on text.
const observe = spawn('tsx', [resolve(here, '../bridge/observe.ts')], {
  env: { ...process.env, CDC_STATE_DIR: stateDir },
  stdio: ['ignore', 'pipe', 'inherit'],
})
let raw = ''
observe.stdout.on('data', (b: Buffer) => { raw += b.toString() })
await sleep(900) // let observe connect + tsx warm up

server.broadcast({ type: 'prompt', source: 'discord', user: 'lily', channel: '123', text: 'hey jackie ping' })
server.broadcast({ type: 'chunk', text: 'pong ' })
server.broadcast({ type: 'chunk', text: 'from jackie' })
server.broadcast({ type: 'update', subtype: 'tool_call', raw: { title: 'read_file' } })
server.broadcast({ type: 'reply', text: 'pong from jackie', files: ['/tmp/x.png'] })
server.broadcast({ type: 'status', msg: 'all good' })
await sleep(500)

const plain = raw.replace(/\x1b\[[0-9;]*m/g, '')
check(plain.includes('discord') && plain.includes('lily'), 'viewer rendered prompt header (source/user)')
check(plain.includes('hey jackie ping'), 'viewer rendered inbound prompt text')
check(plain.includes('jackie'), 'viewer rendered the jackie reply label')
check(plain.includes('pong from jackie'), 'viewer streamed the reply text')
check(plain.includes('tool_call') && plain.includes('read_file'), 'viewer rendered the tool update')
check(plain.includes('x.png'), 'viewer noted the attached file')
check(plain.includes('all good'), 'viewer rendered status')

// Replay log captured every event, in order.
const logged = readFileSync(TURNS_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
check(logged.length === 6, `NDJSON log captured 6 events (got ${logged.length})`)
check(logged.every((e) => typeof e.ts === 'number'), 'every logged event is timestamped')
check(logged[0].type === 'prompt' && logged[4].type === 'reply', 'log preserved event order')

observe.kill('SIGKILL')
server.close()
if (fails.length) {
  process.stdout.write(`\n${fails.length} check(s) failed\n`)
  process.exit(1)
}
process.stdout.write('\nall checks passed\n')
process.exit(0)
