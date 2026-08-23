# deepseek-voice-mode — orchestrator HOST half: assembly checklist

Companion to `host.js` (the complete `code.host` function body for
`cordis_define`) and the frozen specs (`PROTOCOL.md` §3–§4, `RESEARCH.md`).

This file answers the question behind every `// VERIFY(...)` marker in
`host.js`, then gives the define/run/approval sequence for assembling the
dynamic plugin.

---

## 1. What host.js IS

`packages/orchestrator/host.js` is **only the `code.host` body**. It is NOT a
standalone Node module and is NOT runnable by `node host.js` (it is a function
body that must `return { inject, apply }`).

- Paste the whole file verbatim into `cordis_define` → `code.host`.
- `code.client` is intentionally absent — that half is W3's deliverable
  (`packages/client/client.js`). The plugin activates with a host half alone;
  W3 appends the client half as a later Package on the same pluginId.
- The sandbox evaluates the body as the body of an async arrow
  (`(async () => { … })()`); the file contains no top-level module statements.

## 2. Assembly steps (define → run → verify)

1. **Pre-flight inspect (read-only, no approval needed).** Before defining,
   confirm the live contracts the plugin depends on:
   - `cordis_inspect_list` (host) — refresh the provider catalog.
   - `cordis_inspect_query host Service listService` with
     `{service:"subprocess"}`, `{service:"webServer"}`, `{service:"settings"}`,
     `{service:"credentials"}`, `{service:"commands"}`, `{service:"llm"}`,
     `{service:"agentLoop"}`, `{service:"agents"}`, `{service:"sessions"}`,
     `{service:"sessionQuery"}`, `{service:"subagents"}`,
     `{service:"agentDefaultModel"}` — the plugin tolerates any of these being
     absent at runtime (ctx.get + undefined checks), but the assembly target
     assumes they all exist.
   - `cordis_inspect_query host Event listEvents` without input, then exact
     `agent/status`, `agent/error`, `agent/turn-stopping`, `subagent/end`,
     `goal/changed` — confirms payload shapes and dispatch modes.
   - `cordis_inspect_query host Builtin listBuiltins` — confirms `harness`
     surface (`handle` / `defineTool` / `registerTool`).
   - `cordis_inspect_query host Tool listTools` — confirm `voice_say` does not
     collide with an existing tool name.

2. **cordis_define** —
   `plugin: {kind:'new', idPrefix:'voice'}`, `name:'voice-orchestrator'`,
   `purpose:'Voice orchestrator host half: helper transport, intent router, thread manager, speak queue, RPC, tool, command, settings'`,
   `code.host = <contents of host.js>`.
   Records a new pluginId + packageId; defines only, no execution.

3. **cordis_run(pluginId, packageId, mode:'run')** — first activation.
   - A host-only package runs in-process and does **not** enter the browser
     approval flow (applies immediately on the host fiber). `starting` means
     activation was dispatched; the terminal outcome (success/failure) arrives
     via the Run card and steering context — read it there, not in the tool
     result.
   - Expected activation-time behavior: logs
     `[voice.orchestrator] activated (voice plugin host half)`; spawns the
     voice-link helper (node `<voice-link>/entry.js`, cwd = its directory,
     stdin/stdout/stderr piped, `graceMs:3000`, env `ELEVENLABS_API_KEY` from
     the credentials ref `elevenlabs.api_key` when set); writes the `init`
     NDJSON line; waits ≤5 s for the helper's `ready` line.
   - If helperPath is wrong or `node` is not on the provider PATH, the helper
     `done` promise rejects and the plugin logs it; the plugin stays active,
     `voice.diag.ping` reports `helper.failed:true`/`ready:false`, and the ws
     route refuses connections with 503 until fixed via settings.
   - If the plugin fiber fails to activate, read diagnostics with
     `cordis_inspect_self(pluginId, packageId)`, fix the code, append a new
     Package with `cordis_define` (kind 'existing'), and `cordis_run` mode
     'update'.

4. **Settings availability gate.** `settings.register('voice', …)` is wrapped
   so a rejected schema degrades gracefully (plugin still activates). Verify
   with `voice.config.get` RPC or `settings.describe()`; if it returns
   `settings_unavailable`, the callable-schema workaround (§6d) was rejected
   and §D.4 explains what to change.

5. **W1/W2 contract check (M0).** Before the M1 gate, run the framing trials in
   §4 against the real helper:
   a. spawn + `init` → helper replies `ready`.
   b. mint token via `voice.handshake`, connect a WS client to
      `/__dsh-voice/ws?t=…`; helper must send `socket.open` and the browser
      handshake must complete (the helper answers 101 through the tunnel).
   c. one utterence round-trip: speak → `stt.committed` → router → ack
      `tts.speak` → `tts.audio {done:true}` → queue advances, FSM returns to
      `ready`.
   d. kill the helper mid-utterance → `done` settles, `diag.ping` shows
      `ready:false`, next utterance degrades to captions (M1 acceptance §6 of
      PROTOCOL).

6. **Expected approval flow.** None for the host half itself. Browser-facing
   changes that the CLIENT half later introduces (W3) may raise approval
   prompts — that is a per-Package grant decision by the user, outside this
   half. After the client half exists, keep `cordis_run` mode 'update' so the
   current Package never rolls back silently.

## 3. VERIFY marker registry

`// VERIFY(<what to check>)` appears 23 times in `host.js`; each marker names
what must be re-confirmed on the LIVE runtime (source reads done for this
deliverable are recorded as "verified from …"). Order follows the file:

| # | Marker (abridged) | Verify with | Current status |
|---|---|---|---|
| V1 | global availability: Math/Date in the sandbox; AbortController/performance/crypto absent | `Builtin.listBuiltins` + inspect `dsh-cordis-host-runner/lib/types/sandbox.js` (fresh vm context + the 7 builtins + traps) | verified from source: ES intrinsics present, no AbortController/performance/crypto; token uses Date.now+Math.random+counter |
| V2 | helper accepts host-injected `tts.speak` via tunnel with no browser WS peer | M0 trial 5.e against real helper (W1) | open — v1 queue pump is gated on an attached conn (§C.2) |
| V3 | `agentLoop.createAgent(options)` + ownerCtx must be a real ctx | `Service.listService agentLoop` + `agents` | verified: CreateAgentOptions {sessionId, meta?, seed?, agentOptions?, signal?, setup?}; loop reads ownerCtx.fiber/agents/sessions/on/effect → sandbox façade cannot serve as ownerCtx, so the plugin calls `ctx.get('agents').create(options)` (registry builds the real ownerCtx and Reflect.applies the same factory) |
| V4 | `Agent.send(UserMessage, InboxTarget, wakeup)`; MessageId/InboxTarget runtime strings | `Service.listService agents` + dsh-agent runtime-types + dsh-llm message types | verified: UserMessage {id,role:'user',content:[{type:'text',text}],source}; target 'next-step' |
| V5 | `agent.cancel(cause, options)` for a human interrupt | dsh-session AgentCancelCause + dsh-agent runtime-types | verified: `{kind:'user'}` + `{keepInbox:true}` |
| V6 | `subagents.interrupt(id, authority)` fallback | `Service.listService subagents` + dsh-subagent continuation types | verified: {kind:'user',parentSessionId} shape |
| V7 | `sessionQuery.listSessions/readTitleSnapshots/readSession` result shapes | `Service.listService sessionQuery` + dsh-session-query types | verified: SessionRecord{header{id,createdAt}}, title observation {status:'fulfilled', value:{title:{title}}}, snapshot {session,events} |
| V8 | `llm.stream(GenerateOptions)` chunk vocabulary | `Service.listService llm` + dsh-llm types | verified: {provider,model,messages,system,temperature,maxTokens}; chunks text-delta/finish |
| V9 | `agentDefaultModel.currentSelection()` → {provider,model} | `Service.listService agentDefaultModel` + dsh-agent model-selection types | verified |
| V10 | SessionEvent `user/message` + `assistant/message` text blocks | dsh-session types (defensive leaf reads only) | verified shape; fold is defensive |
| V11 | `subprocess.spawn(spec)` + handle streams | `Service.listService subprocess` + dsh-subprocess types | verified: SubprocessSpawnSpec {argv,cwd,stdio,graceMs,env?}; handle {pid,stdin,stdout,stderr,done,terminate} |
| V12 | `credentials.resolve(ref)` → {value,source} | `Service.listService credentials` + dsh-credentials types | verified; ref string 'elevenlabs.api_key' |
| V13 | W1 tunnel payload convention: complete wire bytes vs bare frame payloads | M0 trial 5.b + code review with W1 | open — host stays compatible via heuristic (§C.1): '{'-leading payloads are wrapped into WS text frames, everything else relayed raw |
| V14 | `webServer.registerUpgrade` route shape | `Service.listService webServer` + dsh-host-webserver types | verified: {path, handler(req,socket,head)}; exact-path only, duplicate throws |
| V15 | helper parses reconstructed upstream request bytes and answers 101 through the tunnel | M0 trial 5.b against real helper | open — host currently sends request-line + raw headers + trailing `head` bytes as the first tunnel record |
| V16 | helper treats first-byte-'{' tunnel records as host-injected browser-style frames | M0 trial 5.e (W1 code review) | open — injected tts.speak / listen.* / tts.cancel are sent as bare JSON tunnel payloads |
| V17 | `settings.register(namespace, schema, options)` schema construct | `Service.listService settings` + dsh-settings lib resolve() | verified from source: resolve() CALLS schema(merged); a callable identity fn + .toJSON() is the only sandbox-legal stand-in (no schema builder available) |
| V18 | `harness.handle(method, handler)` contract | `Builtin.listBuiltins` + dsh-cordis-host-runner guard.js | verified: disposer-returning, result clone-wrapped in lossless JSON |
| V19 | `harness.defineTool` DSL + `harness.registerTool` | `Builtin.listBuiltins` + guard.js (parameters DSL, output {schema,render}) | verified: {name,description,parameters,output:{schema,render},execute}; registerTool(ctx, tool) returns disposer |
| V20 | `commands.register(CommandDefinition)` + handler result | `Service.listService commands` + dsh-commands types | verified: {name,description,handler(invocation)→{kind,text}} |
| V21 | Host event payloads (agent/status, agent/error, agent/turn-stopping, subagent/end, goal/changed) | `Event.listEvents` + dsh-agent runtime-types | verified signatures; serial mode on agent/turn-stopping |
| V22 | goal/changed `change` field vocabulary | `Event.listEvents goal/changed` (merge-extensible) | open — plugin reads only scalar `action`/`phase` defensively |
| V23 | one-time handler/thread target resolution semantics (threadTitle-as-hint, router JSON field reuse) | intent-router field naming (PROTOCOL §4) | open design note — message_thread/interrupt/summarize resolve `threadTitle` as an id/title hint, else fall back to the current thread (§D.5) |

## 4. W1/W2 coordination contract (both must match — PROTOCOL §3)

1. **connIdx.** The host uses connIdx **1** for the single v1 connection, mapped
   to `connId:"c1"` in `socket.attach`. W1 must index its single connection the
   same way (u8 in the record header).
2. **Record layout.** magic u32 BE `0x0D51_0001`, connIdx u8, len u32 BE,
   payload. First-byte-'{' classifies a JSON control line (NDJSON, LF-terminated)
   on both pipes; anything else is a binary record beginning with the magic.
3. **Upstream bytes.** The host reconstructs the browser's upgrade request
   (request line + `req.rawHeaders` + CRLF + any `head` bytes) and sends it as
   the FIRST tunnel record after `socket.attach`. W1 parses the HTTP request,
   computes the SHA-1 `Sec-WebSocket-Accept`, and answers the 101 handshake as a
   tunnel record back to the host, which writes it raw to the socket.
4. **Downstream bytes.** Browser socket bytes (masked client frames) are
   forwarded verbatim as tunnel records. W1 parses/unmasks frames.
5. **Host→helper records.** Host-injected browser-style messages
   (`tts.speak`, `tts.cancel`, `listen.start`, `listen.stop`) are tunnel records
   whose payload is bare JSON (starts with '{'). W1 must treat those records as
   if they arrived from the browser as WS text frames. The helper's
   browser-bound WS text frames come back as records whose payload also starts
   with '{'; the host relays them (wrapped into a WS text frame only if W1
   sends unframed payloads — see heuristic in `relayBytes`) AND peeks them for
   `stt.*` / `tts.*` / `session.state` so the FSM/queue react.
6. **Terminals the queue needs.** The host advances the SpeakQueue only on
   `tts.audio {done:true}`, `tts.canceled`, or a `tts_*` error for the active
   utterance id. W1 must emit one of these for every `tts.speak` it accepts.

## 5. Structure map (host.js)

| Section | Lines (approx) | Role |
|---|---|---|
| 0 constants | 1–90 | tunnel magic, ok / conn idx, queue + router + throttle budgets, helper path default |
| 1 utilities | 1–120 | hex, token parse, path split, clamping, JSON copy (plain objects only) |
| 2 framing | 120–210 | `TunnelEncoder` (record build) + `StreamScanner` (line/record split, resync) |
| 3 FSM | 210–250 | disconnected ↔ ready ↔ listening ↔ thinking ↔ speaking; illegal transitions logged |
| 4 captions | 250–270 | ring buffer, last 50 |
| 5 SpeakQueue | 270–340 | priority preemption (tts.cancel), 1.5 s same-class coalescing, class ≥2 cap, ♪ gating |
| 6 ThreadManager | 340–470 | registry, `createAgentOnce` (THE agent factory call site), message/interrupt/summarize/refresh/rows/current/watching/announce |
| 7 IntentRouter | 470–540 | one `llm.stream` call, strict-JSON extraction, 2 s budget via `ctx.timeout` race, fallback route_current |
| 8 leaf-extraction | 540–570 | `foldSessionText` (scalars only, defensive) |
| 9 helper lifecycle | 570–650 | spawn spec (exact), control handling, tunnel record handling, WS-frame peek, relay heuristics |
| 10 upgrade route | 650–720 | token validation, attach, request rebuild, socket ⇄ tunnel piping |
| 11 tokens | 720–740 | mint/prune/consume (single-use, 60 s TTL) |
| 12 tunnel writer | 740–760 | binary write + `sendJson` (injected frames) |
| 13 settings | 760–830 | callable schema + toJSON, defaults incl. `helperPath` |
| 14 RPC | 830–950 | all 13 `voice.*` handlers, one effect-owning batch |
| 15 tool + command | 950–1030 | `voice_say` via harness.defineTool + registerTool; `/voice on|off|status|say` |
| 16 events | 1030–1090 | 5 process-wide listeners → throttled priority-2 announcements |
| 17 apply | 1090–1140 | services via ctx.get, state container, registration order, helper effect |

## 6. Deviations & design decisions

- **D1 (ownerCtx).** PROTOCOL says `agentLoop.createAgent(ownerCtx, …)`; the
  sandbox façade cannot legally BE that ownerCtx (loop reads `ownerCtx.fiber`
  / `ownerCtx.agents` / `ownerCtx.sessions`, which the ctx guard withholds).
  The plugin therefore calls `ctx.get('agents').create(options)`, which the
  AgentRegistry implements as creating the real ownerCtx internally and
  `Reflect.apply`ing the SAME loop factory `createAgent(ownerCtx, options)`.
  The direct `agentLoop.createAgent(ctx-as-owner)` call remains behind
  `createAgentOnce` as a parity fallback (intentionally expected to fail) so
  W4 can re-route in one spot if the assembly wants the direct ergonomic.
- **D2 (settings schema).** `settings.register` wants a schemastery Schema;
  dynamic code has no schema builder. `dsh-settings` resolution CALLS the
  schema (`schema(mergedValue)`), so the plugin registers a callable identity
  function with a `.toJSON()` description (forms still render). Guarded by
  try/catch — a rejection only degrades `voice.config.*`.
- **D3 (no-session TTS).** v1 SpeakQueue only pumps while a browser conn is
  attached (PROTOCOL M1 focus). Announcements are always mirrored to captions
  and coalesced, so nothing is lost — they simply wait for a page.
- **D4 (helperPath).** The task adds a configurable absolute-path setting
  (`helperPath`, default `…/deepseek-voice-mode/voice-link/entry.js`); this is
  an extension beyond PROTOCOL §4's namespace list.
- **D5 (router target hint).** The frozen intent JSON has no target-id field;
  `message_thread` / `interrupt` / `summarize` treat `threadTitle` as an
  id-or-title hint and otherwise fall back to "current" (most recent live
  thread), creating one if none exists.
- **D6 (coalescing semantics).** Same-class coalescing within 1.5 s REPLACES
  the pending head text (freshest intent wins) rather than concatenating —
  chosen to avoid doubling ("…and…" churn) in a spoken channel.
- **D7 (service absence).** Every verb degrades to a lossless-JSON error
  (`{ok:false, code:'service_unavailable', …}`) when a needed service is
  absent — the Fiber never hard-depends on anything but `timer`.

## 7. Acceptance evidence (as shipped)

- `node --check` passes on the sandbox-shaped wrapper `(async () => { <body> })()`.
- Token audit: no `import` / `require` substrings, no standalone `as`, no TS
  type annotations / interfaces / type aliases.
- All 13 `voice.*` RPC method names present, `inject:['timer']` only.
- 23 `// VERIFY` markers, all registered in §3.
- Sandbox-shaped smoke run (bare vm + the 7 builtins + service stubs) passes
  27 checks: spawn spec + key env, 32-char one-time token + single-use refusals,
  upgrade attach → request rebuild → 101 passthrough, WS text-frame wrapping
  heuristic, stt.committed → router → create_thread → spoken ack via tunnel,
  threads.list corpus merge, thread create/message/interrupt, summarize fold,
  agent/status announcement captions, tool + command, helper teardown.
  Re-run with: `node /tmp/voice_smoke.js`.