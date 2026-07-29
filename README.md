# agent-channels

**Talk to your CLI agents in Discord, get the work done**

Discord bridge + MCP tools for CLI coding agents. When someone @mentions your bot, a small **bridge** wakes a warm **ACP agent session**; the bridge posts the reply as **your bot** (default), or the agent can use **Discord MCP** tools in legacy mode.

Supported agents (any CLI that speaks ACP works — set `CDC_AGENT_BIN`):

| Agent | Model examples | Auth |
|-------|----------------|------|
| **Cursor CLI** (default) | Composer | `agent login` (subscription) |
| **Kimi Code CLI** | Kimi K3 (`k3`) | `kimi login` (Kimi Code subscription) |
| **Devin CLI** | GLM 5.2 | `devin auth login` |

```
Discord  →  bridge  →  ACP agent (cursor / kimi / devin)  →  bridge posts reply (default)
                              ↳ or Discord MCP when CDC_BRIDGE_OUTBOUND=mcp
```

Uses your **agent subscription** — no separate API bill. No VPS required to get started.

## Choose your setup

| | **Local (start here)** | **VPS (always-on)** |
|---|---|---|
| **Cost** | No VM — subscription only | ~$5–10/mo server |
| **Difficulty** | Easiest (`nohup` on your Mac) | SSH + systemd |
| **RAM** | Shared with your laptop; scales with concurrent agents | Uses server RAM |
| **Uptime** | Mac powered on, no sleep (lid closed OK with `caffeinate`) | 24/7 without your machine |
| **Agents** | 2–3 bots usually fine; 4+ strains RAM & thermals | Many bots / workspaces |
| **Guide** | [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md) | [docs/VPS_SETUP.md](docs/VPS_SETUP.md) |

## Quick start (local)

```bash
git clone https://github.com/lilyzhng/agent-channels.git
cd agent-channels
npm install
```

1. **[Create a Discord bot](docs/DISCORD_BOT.md)** → save token to `~/.cursor/channels/discord/.env`
2. `agent login`
3. `export CURSOR_CWD=/path/to/your/project` and `export CDC_STATE_DIR=~/.cursor/channels/discord`
4. `npm run bridge` — or `bash scripts/start-bridge-local.sh` for background

Full walkthrough: **[docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md)**

### Using Kimi Code (Kimi K3)

```bash
uv tool install --python 3.13 kimi-cli
kimi login                      # ACP mode needs the OAuth login, not an API key
export CDC_AGENT_BIN=$(which kimi)
export CDC_AGENT_MODE=acp
```

Set the model in `~/.kimi/config.toml` (`default_model = "k3"`, provider `type = "kimi"`,
`base_url = "https://api.kimi.com/coding/v1"`). Keep `default_thinking = false` for fast turns.
The bridge auto-approves the agent's permission prompts by ACP option kind, so Kimi's
tool calls run unattended just like Cursor's.

## What you get

- **@mention your bot** → real reply in the thread
- **Subscription auth** — same quota as Cursor IDE / CLI
- **Access control** — pairing, allowlists, trusted bots
- **Self-hosted** — your token, your rules

## Benchmarks

Measured on a live server against the real agents. The warm ACP session (v0.2)
cuts steady-state latency from **~10 to 12s** (cold spawn per message) to
**~1.2 to 2.5s**, roughly **5 to 10x**, and adds shared cross-channel memory.

We also raced three models on one full agentic task (read PR #5 → author an SVG →
render with `rsvg-convert` → post the image back to Discord):

| Agent | Model | Time |
|-------|-------|------|
| Jackie | Composer 2.5 | **42.3s** |
| Lucy | Sonnet 4.6 | 72.0s |
| Andrej | Opus 4.8 | 103.0s |

Composer 2.5 won on speed and held up on quality; Opus produced the richest-looking
diagram. Full writeup, the three diagrams, and the shell-harness root-cause fix:
**[docs/BENCHMARKS.md](docs/BENCHMARKS.md)**.

## More help

- [docs/DISCORD_BOT.md](docs/DISCORD_BOT.md) — create a bot in Discord Developer Portal (start here if new)
- [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md) — Mac/laptop + nohup (recommended first)
- [docs/VPS_SETUP.md](docs/VPS_SETUP.md) — systemd, multi-agent on a server
- [docs/AUTH.md](docs/AUTH.md) — subscription vs API key
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md) — warm-bridge speedup + cross-model agentic race
- [skills/discord-access/SKILL.md](skills/discord-access/SKILL.md) — who can talk to the bot

## License

MIT
