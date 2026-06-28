# agent-discord-channels

**Talk to your AI coding agents in Discord — one unified memory across every channel**

Discord bridge for any ACP-speaking CLI agent. When someone @mentions your bot, the bridge drives a **warm ACP session** (JSON-RPC over stdio) and posts the reply as your bot. One persistent session is shared across **all Discord channels and threads**, so your agent remembers everything — no per-channel amnesia.

```
Discord  →  bridge  →  agent acp session (warm, shared)  →  bridge posts reply
                              ↳ or Discord MCP when CDC_BRIDGE_OUTBOUND=mcp
```

## Supported agents

Any CLI agent that speaks the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) over stdio:

| Agent | Binary | Auth | Models |
|-------|--------|------|--------|
| **Devin CLI** (Cognition) | `devin` | `devin auth login` | GLM 5.2 Max/High, Claude, GPT, Gemini, Kimi, SWE, Adaptive |
| **Cursor CLI** | `agent` / `cursor agent` | `agent login` (subscription) | Composer, Sonnet, Opus |

Set `CDC_AGENT_BIN` to point at either binary. The bridge handles the rest.

## Why this exists

Most Discord-to-agent bridges give you **per-channel amnesia**: each channel or thread gets its own session, so the agent forgets everything when you switch channels. This bridge holds **one warm ACP session** that is shared across every Discord channel and thread. The agent remembers what you told it in `#research` when you tag it in `#random`.

Each prompt is tagged with its source (channel/thread/user) so the agent stays channel-aware, but the underlying context is unified. This is the core design decision, and it's deliberate.

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
git clone https://github.com/lilyzhng/agent-discord-channels.git
cd agent-discord-channels
npm install
```

1. **[Create a Discord bot](docs/DISCORD_BOT.md)** → save token to `~/.cursor/channels/discord/.env`
2. Authenticate your agent:
   - **Devin**: `devin auth login`
   - **Cursor**: `agent login`
3. Set env vars and start the bridge:
   ```bash
   # Devin
   export CDC_AGENT_BIN=devin
   export CDC_AGENT_MODE=acp
   export DEVIN_MODEL=glm-5.2-max        # optional: pin a model
   export DEVIN_PERMISSION_MODE=dangerous # auto-approve tools (for headless)

   # Cursor
   export CDC_AGENT_BIN=agent             # or /path/to/cursor-agent
   export CDC_AGENT_MODE=acp
   export CURSOR_MODEL=composer-2.5       # optional: pin a model

   # Shared
   export CURSOR_CWD=/path/to/your/project
   export CDC_STATE_DIR=~/.cursor/channels/discord
   npm run bridge
   ```

Full walkthrough: **[docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md)**

## What you get

- **Unified memory** — one warm session shared across all channels and threads
- **@mention your bot** → real reply in the thread
- **Warm ACP session** — ~1.2s steady-state vs ~10s cold spawn per message
- **Agent-agnostic** — swap between Cursor and Devin via one env var
- **Access control** — pairing, allowlists, trusted bots
- **Self-hosted** — your token, your rules

## Benchmarks

Measured on a live server against the real agents. The warm ACP session (v0.2)
cuts steady-state latency from **~10 to 12s** (cold spawn per message) to
**~1.2 to 2.5s**, roughly **5 to 10x**, and adds **shared cross-channel memory**.

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
