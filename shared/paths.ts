import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** Per-agent override via CDC_STATE_DIR, e.g. ~/.cursor/channels/discord-mybot */
export function stateDir(): string {
  if (process.env.CDC_STATE_DIR) return process.env.CDC_STATE_DIR
  const cursor = join(homedir(), '.cursor', 'channels', 'discord')
  const claude = join(homedir(), '.claude', 'channels', 'discord')
  if (existsSync(join(cursor, '.env')) || existsSync(join(cursor, 'access.json'))) {
    return cursor
  }
  if (existsSync(claude)) return claude
  return cursor
}

export const STATE_DIR = stateDir()
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')
/** Local-only control socket: observe (and later steer) the warm session. */
export const CONTROL_SOCK = join(STATE_DIR, 'control.sock')
/** Append-only NDJSON log of turn events, for replay. */
export const TURNS_LOG = join(STATE_DIR, 'turns.ndjson')
