import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"

import { spawnAgentSync, agentBin } from "./cursor-bin.js"

/** Subscription login via `agent login` — not API key billing.
 *
 * Devin CLI: auth check via `devin auth status` (different subcommand shape).
 * Cursor CLI: auth check via `agent status`.
 * Kimi Code CLI: `kimi acp` requires a persisted OAuth token from `kimi login`
 * (an API key in ~/.kimi/config.toml is NOT enough for ACP mode). */
export function ensureCursorSubscriptionAuth(): void {
  const bin = agentBin()
  const isDevin = bin.includes("devin")
  const isKimi = bin.includes("kimi")

  if (isKimi) {
    const cred = join(homedir(), ".kimi", "credentials", "kimi-code.json")
    if (existsSync(cred)) return
    process.stderr.write(
      "bridge: Kimi Code login required (ACP mode needs the OAuth token, not an API key).\nRun: kimi login\n",
    )
    process.exit(1)
  }

  const r = isDevin
    ? spawnAgentSync("auth", ["status"])
    : spawnAgentSync("status", [])
  const out = String(r.stdout ?? "") + String(r.stderr ?? "")
  if (r.status === 0 && /logged in/i.test(out)) return

  process.stderr.write(
    isDevin
      ? "bridge: Devin auth required. Run: devin auth login\n"
      : [
          "bridge: Cursor subscription login required (not CURSOR_API_KEY).",
          "Run: agent login",
          "On a droplet: SSH in and login once, or use scripts/reauth.sh from your laptop.",
          "This uses your Pro/Max subscription quota — same as running the agent in your IDE.",
          "",
        ].join("\n"),
  )
  process.exit(1)
}
