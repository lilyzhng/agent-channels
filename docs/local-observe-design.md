# Local observe + steer for the warm bridge

**Goal.** When Lily is local on the droplet: (1) **see** Jackie's live input + output as he works, and (2) **guide** him by typing into the *same* warm session Discord uses (shared context). Parity with Claude Code's `--channels` attach, for a Cursor Composer agent.

## Why not just `tmux` the agent

`cursor-agent acp` is driven programmatically by the bridge over JSON-RPC (ACP). Attaching to it shows protocol frames / logs, not a chat. Spawning a fresh interactive `cursor-agent` is a **separate session** = lost context ("two faces"). The leverage point is **the bridge** — it owns the one warm session — not cursor-agent, not tmux.

## Load-bearing constraints (from the code)

- **Single warm session, strictly serial.** `AcpSession.chunkBuf` is one shared buffer; streamed `agent_message_chunk` carry no request id. `daemon.drainQueue` is `busy`-guarded and `await`s each turn, so **exactly one `prompt()` is ever in flight** across all channels. Any injected input MUST go through the same queue. (`bridge/acp-client.ts` prompt() docstring.)
- **Output already streams.** `acp-client.onLine` already receives `session/update → agent_message_chunk` and pushes to `chunkBuf`. Today only the final assembled text is posted to Discord. The live stream is **already in the pipe, just untapped.**

## Design — one local control socket on the daemon

Transport: a **Unix domain socket** in `CDC_STATE_DIR` (e.g. `control.sock`), mode `0600`, **local-only, never network-exposed**. Newline-delimited JSON both directions. Events also mirrored to an NDJSON log (`turns.ndjson`) for replay.

Event shapes (daemon → observers):
```
{type:'prompt', source:'discord'|'local', user, channel, text, ts}
{type:'chunk',  text}            // streamed, live as Jackie thinks
{type:'reply',  text, files}     // final assembled turn
{type:'tool',   name, ...}       // if ACP surfaces tool/file events (TBD, see Q2)
{type:'status', msg}             // timeout / restart / respawn
```

Pieces:
- `bridge/control-socket.ts` — socket server + broadcast bus. Phase 1: broadcast only.
- `bridge/acp-client.ts` — add `onChunk(text)` callback at the existing `chunkBuf.push` point so chunks fan out live (final reply unchanged).
- `bridge/daemon.ts` — emit `prompt`/`reply`/`status` events around each turn.
- `bridge/observe.ts` — client: connects to socket, renders a clean live transcript. **Read-only in Phase 1.**
- connect-agent skill — `connect jackie` SSHes in and tmux-wraps `observe.ts`; detach `Ctrl-b d`.

## Phasing

**Phase 1 — observe (read-only). Ship first.**
- Socket server (broadcast), tap prompt-in + chunk/reply-out, `observe.ts` renderer, `connect.sh` jackie path.
- **Zero risk to serial-prompt correctness** — pure read tap.
- Delivers the core "watch him think + reply live" value.

**Phase 2 — steer / inject. DONE.**
- Queue generalized to `InboundTurn = {kind:'discord', msg} | {kind:'local', text}`; `processTurn` dispatches. One `runAcpTurn(prompt, deliver)` serves both — `deliver` posts to Discord for a Discord turn, no-ops for a local turn (the observer already shows the streamed reply).
- `observe.ts` reads stdin; each typed line is sent as `{type:'inject',text}` over the socket → daemon `enqueue({kind:'local'})` → **same `drainQueue` → same warm session/context.** Reply streams back to the terminal via the broadcast.
- **No prompt variant.** Lily's typed text goes into the warm session RAW — she's talking to Jackie directly, like attaching to a Claude Code agent. Decided against a "you're being steered from a terminal" wrapper: don't overcomplicate, don't be over-cautious. We don't post local replies to Discord ourselves; if Jackie chooses to use a Discord tool, fine, we don't care.
- Local turns skip the Discord access gate (sender is on the box = trusted). Single-queue serial guarantee intact.

## Security

- Socket file `0600` in state dir, never bound to network. Observers = whoever can read the socket on the droplet (`genius`/`root`).
- Phase 2 injection is a **local trust boundary**; adds no remote surface.
- `ATTACH` path allowlist unchanged.

## Files

- **new:** `bridge/control-socket.ts`, `bridge/observe.ts`
- **edit:** `bridge/acp-client.ts` (onChunk), `bridge/daemon.ts` (emit; P2 inbound generalize), `shared/paths.ts` (`CONTROL_SOCK`), connect-agent `connect.sh` + `SKILL.md`
- **docs:** this file

## Resolved

1. **P2 echo:** terminal-only. We don't post local replies to Discord. (No `CDC_LOCAL_ECHO_DISCORD` flag — kept simple.)
2. **No prompt variant:** raw passthrough, decided above.
3. **connect verb:** one verb. `connect jackie` opens the viewer, which also takes typed input (watch + talk in one window).

## Open

- **Observe richness:** does ACP surface tool-call / file-read events as other `session/update` subtypes? `onUpdate` logs them (type `update`) so we can see what's there from real traffic and prettify `summarizeUpdate` later.
