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

**Phase 2 — steer / inject. After Phase 1 proven.**
- Generalize the queue: hold a discriminated `InboundTurn = DiscordTurn | LocalTurn` instead of raw `Message`. `processMessage` branches on `source` for reply routing (Discord post vs socket echo).
- Local prompt from `observe.ts` → socket → `enqueue` → **same `drainQueue` → same warm session/context.** Reply streamed back to the terminal; optionally also posted to the originating Discord thread (`CDC_LOCAL_ECHO_DISCORD`, default off).
- Local prompts **skip the Discord access gate** (sender is on the box = trusted) but are tagged `source=local` in the prompt block so Jackie knows it's Lily steering.
- Risk: inbound-type refactor. Keep the single-queue serial guarantee intact.

## Security

- Socket file `0600` in state dir, never bound to network. Observers = whoever can read the socket on the droplet (`genius`/`root`).
- Phase 2 injection is a **local trust boundary**; adds no remote surface.
- `ATTACH` path allowlist unchanged.

## Files

- **new:** `bridge/control-socket.ts`, `bridge/observe.ts`
- **edit:** `bridge/acp-client.ts` (onChunk), `bridge/daemon.ts` (emit; P2 inbound generalize), `shared/paths.ts` (`CONTROL_SOCK`), connect-agent `connect.sh` + `SKILL.md`
- **docs:** this file

## Open questions

1. **P2 echo:** should local-injected replies also post to Discord (thread keeps a record), or terminal-only? Proposed default: terminal-only (`CDC_LOCAL_ECHO_DISCORD=0`).
2. **Observe richness:** does ACP surface tool-call / file-read events as other `session/update` subtypes? If yes, showing them makes guiding far more useful. Phase 1 will log all unseen `session/update` subtypes to find out.
3. **connect verb:** keep `connect jackie` = observe (read-only) and add a separate `guide jackie` / `--steer` flag for Phase 2 inject? Or one verb that's read-write once P2 lands?
