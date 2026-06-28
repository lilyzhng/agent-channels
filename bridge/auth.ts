import { basename } from 'path'
import { spawnAgentSync, agentBin } from './cursor-bin.js'

/** Ensure the configured CLI agent is authenticated.
 *
 * Agent-agnostic: detects whether CDC_AGENT_BIN points at Devin CLI or Cursor
 * CLI and runs the appropriate auth-status subcommand:
 *   Cursor: `agent status`
 *   Devin:  `devin auth status`
 *
 * Uses basename comparison so wrapper dirs like `/foo/devin-tools/bin/x`
 * don't false-match the substring "devin".
 */
export function ensureAgentAuth(): void {
  const bin = agentBin()
  const isDevin = basename(bin) === 'devin'

  const r = isDevin
    ? spawnAgentSync('auth', ['status'])
    : spawnAgentSync('status', [])
  const out = String(r.stdout ?? '') + String(r.stderr ?? '')
  if (r.status === 0 && /logged in/i.test(out)) return

  process.stderr.write(
    isDevin
      ? 'bridge: Devin auth required. Run: devin auth login\n'
      : [
          'bridge: Cursor subscription login required (not CURSOR_API_KEY).',
          'Run: agent login',
          'On a droplet: SSH in and login once, or use scripts/reauth.sh from your laptop.',
          'This uses your Pro/Max subscription quota — same as running the agent in your IDE.',
          '',
        ].join('\n'),
  )
  process.exit(1)
}
