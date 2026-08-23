# deepseek-voice-mode — Verified Research Log

Facts below were verified against live sources on 2026-02-14 (ElevenLabs docs fetched directly,
DSH capabilities read from the running runtime's Inspect providers). Do not code against memory —
re-verify anything marked UNVERIFIED before relying on it.

## 1. ElevenLabs product surface (current)

Source index: https://elevenlabs.io/docs/llms.txt (clean markdown: append `.md` to any docs URL)

### 1a. Speech Engine — BYO-LLM voice layer (NEW, relevant)
- Docs: https://elevenlabs.io/docs/overview/capabilities/speech-engine.md
  Quickstart: https://elevenlabs.io/docs/eleven-api/guides/cookbooks/speech-engine.md
  JS SDK ref: https://elevenlabs.io/docs/eleven-api/resources/libraries/speech-engine/javascript-sdk-reference.md
- Model: ElevenLabs does mic capture + STT + TTS + turn-taking + interruption; YOUR server gets
  transcripts over WebSocket and streams text back (`session.sendResponse(string | AsyncIterable)`).
- SDK auto-extracts text from OpenAI / Anthropic / Gemini stream formats; plain async iterables of
  strings also accepted. Interruption fires an `AbortSignal` into the in-flight `onTranscript`.
- **Hard constraint:** ElevenLabs dials INTO your server. Requires a publicly reachable
  `wss://…` URL (docs say use ngrok locally). Inbound requests carry JWT header
  `X-Elevenlabs-Speech-Engine-Authorization`, verifiable via `engine.verifyRequest(req)`
  (signed with SHA-256 hash of API key). `engine.attach(httpServer, '/ws', cb)` or standalone
  `SpeechEngine.Server`, or manual `engine.createSession(ws)` for custom upgrade handling.
- **Why not primary for us:** `sendResponse()` must be called inside the `onTranscript` handler —
  a strict request/response chat-turn model. Our voice mode is a dispatcher whose answers often
  arrive seconds-to-minutes later and are PROACTIVELY spoken (thread finished, tests pass).
  Callback-scoped responses fight that. Re-evaluate later as an optional "phone-call style"
  adapter.

### 1b. Scribe v2 Realtime — streaming STT (PRIMARY STT)
- Guide (server-side): https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/server-side-streaming.md
- Commit strategies: https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies.md
- Events: https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference.md
- WS-based. Connect options seen in docs: `modelId: "scribe_v2_realtime"`,
  `audioFormat: pcm_16000`, `sampleRate: 16000`, `commitStrategy: manual | vad(auto?)`,
  `includeTimestamps: true`. Auth: regular API key server-side (client-side uses single-use token).
- Events: SESSION_STARTED, PARTIAL_TRANSCRIPT, COMMITTED_TRANSCRIPT,
  COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, ERROR, CLOSE (SDK enum `RealtimeEvents`).
- Commit semantics: manual strategy = we decide; VAD strategy = built-in endpointing commits when
  speech segment completes; model force-commits after ~36s accumulated audio either way.
- React SDK hook exists: `useScribe({modelId, onPartialTranscript, ...})` (@elevenlabs/react).

### 1c. Realtime TTS stream-input WebSocket (PRIMARY TTS)
- Guide: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts.md
- Endpoint: `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id=…`
- Recommended low-latency model: `eleven_flash_v2_5` (~75ms TTFB, 32 langs).
  Expressive realtime option: `eleven_v3_conversational` (~280ms, audio tags).
  NOTE: stream-input WS does NOT support plain `eleven_v3` (that's Text-to-Dialogue WS only).
- Protocol: first message = voice_settings + generation_config
  (`chunk_length_schedule: [120,160,250,290]`) + auth; then `{"text": …}` chunks;
  empty string `{"text": ""}` closes. Responses: JSON messages `{audio: <base64 mp3>}`,
  `isFinal` marker. Also `try_trigger_generation_async` style flush semantics exist — verify exact
  field names against the API reference during M0.
- There is ALSO a plain HTTP streaming endpoint (chunked transfer encoding) and a Multi-Context
  WebSocket (parallel generation contexts on one connection) — candidates if web.fetch streams.

### 1d. Other notes
- Models overview: https://elevenlabs.io/docs/overview/models.md
- Their own agent skill exists (`npx skills add elevenlabs/skills --skill speech-engine`) — useful
  reference material for our voice-link implementer.
- Pricing: check https://elevenlabs.io/pricing/api when the key arrives; budget guard = settings cap.

## 2. Harness runtime capabilities (read from live Inspect providers)

### Host Services we will consume (exact signatures captured from Service catalog)
- VERIFIED from dsh-agent/dsh-llm type defs:
  - `agentLoop.createAgent(ownerCtx, {sessionId, meta?:{cwd,parentSession,seedLength,origin,
    delegationDepth,agentPreset}, seed?, agentOptions?, signal?, setup?}) -> Promise<AgentHandle>`
  - `AgentHandle = {agent: Agent, dispose(): Promise<void>}`
  - `Agent.send(message: UserMessage, target: 'next-turn'|'next-step', wakeup: boolean)` — THE
    programmatic message insertion path (queues + wakes driver). Mid-turn nudge: `agent.steer(msg)`.
  - Build messages with `createUserMessage({content:[{type:'text',text}], source:{kind:'plugin',
    plugin:'deepseek-voice-mode', ...}})` (dsh-llm message.d.ts; id auto-minted, frozen).
    VERIFIED round 6: `TextBlock={type:'text',text:string}`; ContentBlock union =
    text|reasoning|image|tool-call|tool-result. Remaining VERIFY: full plugin-source fields.
  - Intent router: `llm.stream({provider, model, messages, system, maxTokens, ...})` — VERIFIED
    GenerateOptions; provider/model from `agentDefaultModel.currentSelection()`.
  - `SessionId = Branded<'SessionId'>` — compile-time only; ANY unique string works at runtime.
    Convention decision: orchestrator mints `voice-<base36 time>-<4 rand>` ids.
- `agents` registry: `get(id)`, `list()`, `roots()`, `register(agent)` — live agents.
- `sessions` (in-memory store): `create/prepare/enter/announce/fork/get/list`.
- `sessionQuery`: `listSessions()`, `readSession(id)`, `searchSessions(request)`, `listEvents(id)`
  — enumerate/report on threads.
- `subagents`: `startContinuable(spec)`, `followup(...)`, `interrupt(targetSessionId, authority)`
  — durable child threads we can message later; plus events `subagent/start`, `subagent/end`.
- `llm.stream(GenerateOptions)` — direct model calls for the fast intent-classifier step
  (also `llm/stream` waterfall event).
- `webServer` — VERIFIED from @deepseek-ai/dsh-host-webserver/lib/types/index.d.ts:
  `registerUpgrade({path: string, handler(req: IncomingMessage, socket: Duplex, head: Buffer)})`
  — exact-path only, duplicate paths throw, handler owns negotiation AND the raw socket.
  Dynamic host code has no crypto builtin ⇒ cannot compute Sec-WebSocket-Accept itself ⇒ the
  voice-link helper owns the WS handshake; host pipes socket bytes verbatim over stdio
  (framing in PROTOCOL.md §3). HTTP routes: `{kind:'exact'|'prefix', path, handler(req,res)}`
  (SSE-capable). Also `registerFallback`, `tapIndex`, `renderIndex`.
- `credentials`: `set(ref,value)/resolve(ref)/listRecords()` — store ElevenLabs key host-side,
  never sent to browser. VERIFIED round 6: `CredentialRef` = branded POSIX env-var NAME ⇒ our
  ref is literally 'ELEVENLABS_API_KEY'; stored records address as `<scope>/<id>` keys.
- `settings.register(ns, schema)` — voice settings namespace.
- `jobs`: `start(spec)/kill/read/onJobsChanged` — manage the voice-link helper process lifecycle.
- `jobs`: `start(JobStart{kind,label,outputLimitBytes?,owner?,run():JobHooks})` — VERIFIED from
  dsh-jobs types; JobHooks `cancel(reason?)`; unowned job when `owner` omitted.
- `subprocess.spawn(SubprocessSpawnSpec)` — VERIFIED from dsh-subprocess types:
  `{argv:[...], cwd, stdio:{stdin:'ignore'|'pipe'|{data}, stdout:'pipe'|'inherit'|{maxBytes,spill?},
  stderr:same}, graceMs, signal?, env?}` → SubprocessHandle with raw Readable/Writable for piped
  streams, tree-scoped terminate, post-exit collected reads. Voice-link uses
  stdin/stdout 'pipe' (NDJSON + byte-tunnel framing), stderr 'pipe'.
- `shell` / `fs` — general purpose.
- `authorization.registerFlow` — guided key-entry flow in Settings.
- Dynamic Tools via `harness.defineTool` + `tools.register`; human commands via `commands.register`.
- Runtime Node for helper processes: **v22.23.2** (`node` on PATH) — global `WebSocket`,
  `node:crypto`, `fetch` all available ⇒ voice-link is dependency-free.
- Client↔Host package-private RPC: `harness.handle(method, handler)` ↔ `host.call(method,args)`
  — lossless JSON only. Binary audio goes over the registerUpgrade WebSocket instead.

### Host Events we will listen to
- `agent/status` {agent, status} — idle⇄running per thread → spoken status.
- `agent/error`, `agent/turn-stopping` — completion/failure signals for "report back".
- `session/event`, `session/created`, `session/disposed`.
- `approval/request` (waterfall) — voice-announced approvals later.
- `goal/changed` — goal progress announcements.
- `workflow/*`, `subagent/start|end`.

### Client surfaces (from Slots tree)
- `shell.overlay` — list slot, frame-wide floating layer above all columns → voice pill/panel. Additive, zero risk.
- `sidebar.footer.action` — list slot → global mic toggle.
- `conversation.input.left` — list slot inside composer tool row → per-session push-to-talk mic button.
- `composer.dock` — ambient readout band under composer (live caption line).
- `settings.section` — full Voice settings page (list registration, id+label).
- `conversation.view` — view-tab ring (chat/trajectory/…) → optional "Voice" tab later.
- `tool.view.cordis` with key:'self' — Run-card panel for activation status/debug.

### Runtime constraints (verified via Builtin providers — hard rules for plugin code)
- Host dynamic code builtins: ONLY `ctx`, `harness`, `console`, `btoa/atob`, `TextEncoder/TextDecoder`.
  NO `fetch`, NO `WebSocket`, NO `process`, NO `Buffer`, NO timers (use `timer` service).
  ⇒ Outbound ElevenLabs sockets CANNOT be opened from inline dynamic host code directly.
- Client dynamic code builtins: ONLY `React`, `host.call`, `styles.insert`, `console`.
  Browser globals (`navigator.mediaDevices`, `WebSocket`, `AudioContext`, `window`, `document`)
  presumably reachable in-page but MUST be probed (M0) before the design leans on them.
- Client↔Host package-private RPC: `harness.handle(method, handler)` ↔ `host.call(method, args)` —
  lossless JSON only. Binary audio goes over the registerUpgrade WebSocket instead.

## 3. Reference bar
- OpenAI Realtime API voice UX: near-instant barge-in, ~300–800ms conversational round-trip.
  Our budget: audible ack ≤ 700ms after end-of-speech; first content word ≤ 2.5s typical.
