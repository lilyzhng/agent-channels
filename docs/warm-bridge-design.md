# Design Doc: A warm, persistent bridge for Cursor Agent

**Status:** Reviewed (grilled) + updated after research. Ready to execute.
**Author:** Bill (genius-builder)

## TL;DR

We want Jackie (Cursor Agent) to be **warm** on Discord like the Claude Code agents: a persistent session that an external channel feeds, instead of cold-spawning `cursor-agent -p` per message (which pays a binary-init + MCP-handshake + context-re-read tax on every message and is why Jackie answers last on the droplet).

**Cursor officially provides the missing piece.** `cursor-agent acp` runs the agent as an **ACP (Agent Client Protocol) server** — a persistent process you drive over JSON-RPC/stdio: `initialize` → open a session → send prompts → stream responses, tool calls, and permission requests. That is the "consuming end" — the warm harness — and it is **official and standard, not a TUI hack**.

> An earlier draft of this doc concluded cursor-agent had no such mode and proposed PTY-driving the interactive TUI. That was an under-researched error. `cursor-agent acp` is real (verified on the binary, v2026.06.12) and is the clean path. The PTY approach is discarded.

**The build:** a bridge that is an **ACP client** — it listens to Discord, keeps **one warm, shared `cursor-agent acp` session** (Jackie is a long-running assistant, so context is shared across all channels, channel-aware, like Claude Code `--channels` — not isolated per channel), and forwards each Discord message as an ACP prompt tagged with its source. We borrow the bridge skeleton from existing OSS and plumb in the ACP client.

---

## Background: how Claude Code Channels is warm (the reference)

`claude --channels plugin:discord@...` is a **two-ended, Claude-specific channel protocol**:
- **Channel end (the plugin):** an MCP server that also speaks `claude/channel` — it connects to Discord and *pushes* each message to Claude Code (`notifications/claude/channel`), plus exposes `reply`/`fetch_messages`/etc tools.
- **Consuming end (Claude Code's `--channels` runtime):** one long-lived agent session that *consumes* those pushes, injecting each as a turn. The session stays warm between messages.

The warmth comes from the consuming end (Claude Code's runtime), not the plugin. We need an equivalent consuming end for Cursor.

## The finding: Cursor's consuming end is `cursor-agent acp`

- `cursor-agent acp` = "Start the Cursor Agent as an **ACP (Agent Client Protocol) server**" (verified on the binary).
- **ACP** is an open standard (originally from Zed) for client↔agent communication over **JSON-RPC on stdio**: `initialize` → `session/new` → `session/prompt` → streamed response updates (text deltas, tool calls, permission requests).
- So the warm harness for Cursor is: run `cursor-agent acp` as a persistent server, and make our bridge the **ACP client** that opens a session per Discord channel and sends each message as a prompt. The process stays warm in memory — no cold spawn, no terminal screen-scraping.
- Because ACP is a standard, the same client generalizes to any ACP-speaking agent (OpenCode, Gemini CLI, …). That is upside, not the goal; the goal is Cursor.

## How Cursor works today (cold)

`cursor-discord-channels` is an external Node daemon that listens to Discord and runs `cursor-agent -p "<message>"` per message. `-p` is one-shot: spawn → cold start → run → exit. The bridge is persistent; the agent is not. We are replacing that with a warm ACP session.

## Prior art — what to borrow, what to plumb through

Two classes of existing OSS bridge:

1. **Screen-scraping (tmux)** — `discord-agent-bridge`: runs the agent in tmux and `capture-pane` every 30s, diffing snapshots to Discord. Fragile, laggy, no structured events; supports Claude Code/OpenCode, **not Cursor**. **Do not use this pattern.**
2. **Server-API client** — `discord-opencode-bridge`: uses OpenCode's native server (`opencode serve`); the bridge is a client with a `SessionManager` mapping `channelId → sessionId`. Robust and structured. Its README explicitly says swapping the agent is just changing the client service layer. **This is the architecture to borrow.**

**Plan: borrow the server-API bridge skeleton; plumb in an ACP client for `cursor-agent acp`.**
- **Reuse:** Discord listener, per-channel `SessionManager`, message chunking, and our existing access-control/`trustedBots` gate from `cursor-discord-channels`.
- **Write new:** the ACP client adapter — the JSON-RPC/stdio handshake and `session/prompt` calls against `cursor-agent acp`. This is the ~20% that is genuinely new; the skeleton is the ~80% we borrow.

## Design: the ACP-client bridge (one shared, channel-aware session)

Jackie is a **long-running assistant**, not a disposable per-task agent. A coding bridge like `discord-opencode-bridge` isolates one session per channel because there each channel is an independent, throwaway project — isolation prevents cross-project context bleed and keeps each task's context bounded. Jackie is the opposite: one persistent companion who should remember everything across every channel (tell him something in the debrief thread, he still knows it when you ping in podcast-replay). So we use **one shared session with full cross-channel memory** — exactly how Claude Code `--channels` works (one persistent session fed by all channels, each message tagged with its source).

- **One warm `cursor-agent acp` process holding one shared session.** Every Discord message, from any channel or thread, is sent into that same session via `session/prompt`.
- **Each message is wrapped with source metadata** — a `<channel source="discord" chat_id=… thread_id=… user=…>`-style header (mirroring the Claude plugin). So the agent has coherent global context *and* knows where each message came from, where to reply, and which topic to follow.
- **Reply routing:** the bridge tracks which channel/thread triggered the current turn and routes the agent's reply back there.
- Access control: reuse the existing `cursor-discord-channels` gate (allowlist / `trustedBots`).
- Watchdog: health-check the shared session; restart it if wedged (existing consecutive-timeout watchdog).
- Context growth is managed by cursor-agent's own compaction (same as Claude Code). Turns are serial within the one session (same as `--channels`).
- *(Future option: opt-in isolated session for a specific heavy/autonomous task that shouldn't be polluted by unrelated chatter. Default is shared.)*

## Phase 1 (MVP) — prove the pipe

A standalone minimal ACP client that:
1. spawns `cursor-agent acp`;
2. performs the JSON-RPC handshake: `initialize` → `session/new` → `session/prompt` with a trivial prompt;
3. reads the streamed response and prints it.

**Success = one warm session, feed one prompt, get one structured response back** — proving ACP is cleanly driveable. No Discord, no multi-channel, no MCP. This replaces the earlier fragile PTY probe; ACP is a documented protocol, so this should be clean.

## Phase 2 — the bridge

Once the pipe is proven: borrow the `discord-opencode-bridge` skeleton, wire the ACP client as the agent service, map channels → sessions, integrate the existing access gate, add the per-session watchdog. Swap `cursor-discord-channels` from `-p`-per-message to the warm ACP client.

## Risks
- **ACP feature completeness in cursor-agent** — does `acp` fully support tool-use / permission prompts / streaming as we need? Validate in the MVP before committing to the bridge swap.
- **Memory** — one warm process/session per channel on the 3.8 GB box; may need an LRU of warm sessions.
- **Resilience** — a wedged ACP session needs the existing watchdog applied per session.
- **Discarded alternative** — PTY-driving the interactive TUI (fragile screen-scraping). Unnecessary now that `cursor-agent acp` exists; kept here only as the rejected option.
