# deepseek-voice-mode — Wire Protocol & Component Specs (FROZEN v1)

Verified runtime facts live in RESEARCH.md. This file is the contract every implementer codes
against. Changes require updating this file first (protocol version bump), then implementations.

## 0. Topology

```
Browser page                    Host dynamic plugin(s)                voice-link helper (Node 22, dep-free)
┌──────────────────┐  WebSocket ──────────────────────┐   stdio NDJSON   ┌──────────────────────────┐
│ client-ui plugin │◄--------------------------------►│ voice.transport  │◄------------------------►│
│ mic→PCM16 frames │   ws://127.0.0.1:<port>/__dsh-voice/ws        │  base64 audio in JSON   │ Scribe STT WS │
│ AudioContext out │   (webServer.registerUpgrade;      │  (newline-       │ TTS stream-input WS     │
└──────────────────┘    host pipes raw socket bytes)   │   delimited)     └──────────────────────────┘
```

- Host plugin code has NO crypto/WebSocket builtins → it cannot do the WS handshake itself.
  It pipes the upgraded Duplex's bytes verbatim to the helper over stdio using the byte-tunnel
  framing in §3. The helper performs handshake (SHA-1 accept via node:crypto), framing, and all
  ElevenLabs protocol work.
- Control plane (orchestrator ↔ UI) is package-private RPC: `harness.handle` / `host.call`,
  lossless JSON only. See §5.

## 1. Browser ⇄ helper WebSocket (data plane)

Path: `/__dsh-voice/ws` (exact-path upgrade route). Query: `?t=<one-time token>`.
Token: minted per page by orchestrator RPC `voice.handshake` → `{token}` (32 hex chars,
single-use, 60s TTL, held in memory only). Helper receives it in the `hello` control message;
host validates before piping (it saw the URL during upgrade dispatch) — belt and braces:
helper also refuses to start session without a valid `hello`.

Frames after upgrade:
- Binary frame C→S: raw mic audio. 16 kHz, mono, signed 16-bit LE PCM. Chunk ~4096 samples
  (256 ms) or whatever AudioWorklet emits; helper re-chunks as needed.
- Text frames both directions: UTF-8 JSON, one message per frame.

C→S text messages:
```
{type:'hello', token:string, proto:1, capabilities?:string[]}
{type:'listen.start', commit:'vad'|'manual', language?:string}   // begins STT stream
{type:'listen.stop'}                                             // ends STT stream (flush+commit)
{type:'tts.speak', id:string, text:string, priority?:number}     // queue handled host-side; helper just synthesizes
{type:'tts.cancel', id?:string}                                  // omit id = cancel current utterance
{type:'ping', ts:number}
```
S→C text messages:
```
{type:'ready', proto:1}
{type:'session.state', state:'idle'|'listening'|'thinking'|'speaking', reason?:string}
{type:'stt.partial', text:string}
{type:'stt.committed', text:string}
{type:'stt.error', code:string, message:string}
{type:'tts.start', id:string}
{type:'tts.audio', id:string, b64:string, done?:boolean}         // base64 mp3 chunks; done=true terminates utterance
{type:'tts.canceled', id:string}
{type:'pong', ts:number}
{type:'error', code:string, message:string, fatal?:boolean}
```
Semantics:
- One WS connection per page = one VoiceSession. Reconnect = new hello.
- Barge-in: client stops playback on `stt.partial` while speaking (policy in orchestrator),
  sends `tts.cancel`; helper aborts the TTS socket send side and stops emitting audio for that id.
- Heartbeat: client pings every 15 s; helper closes dead peers after 30 s silence.

## 2. Helper ⇄ ElevenLabs

STT (per listen session): WSS Scribe v2 Realtime, `model_id=scribe_v2_realtime`,
`audio_format=pcm_16000`, `sample_rate=16000`, `commit_strategy=vad` (default) or manual,
auth via API key header. Map partial/committed events straight through. Force-commit if no
commit for >20 s of streamed audio (docs: model force-commits ~36 s; we stay ahead of it).
Reconnect with backoff on close; surface `stt.error` codes: `stt_auth`, `stt_net`, `stt_proto`.

TTS (per utterance): WSS `/v1/text-to-speech/{voiceId}/stream-input?model_id=<ttsModel>`
(default `eleven_flash_v2_5`). First frame: voice_settings + generation_config
(`chunk_length_schedule:[120,160,250,290]`) + auth. Then text chunks split at sentence
boundaries (~≤200 chars). Empty-string frame ends. Emit each `{audio}` chunk as `tts.audio`;
`isFinal` ⇒ `tts.audio{done:true}`. Abort on cancel. Errors: `tts_auth`, `tts_net`, `tts_proto`.
Key source: env `ELEVENLABS_API_KEY` passed by host at spawn (host resolves from credentials
service; helper NEVER persists or logs it).

## 3. Host ⇄ helper stdio framing

All messages newline-delimited JSON on stdin/stdout (UTF-8). stderr is free-form diagnostics.

Host→Helper stdin:
```
{"type":"init","proto":1,"logLevel":"info"}                      // first line, always
{"type":"socket.attach","connId":"c1","url":"/__dsh-voice/ws?t=<tok>"} // then raw bytes follow via tunnel
{"type":"socket.detach","connId":"c1"}
{"type":"stop"}
```
Helper→Host stdout (control):
```
{"type":"ready","proto":1,"pid":1234}
{"type":"socket.open","connId":"c1"}                             // upgrade accepted (101)
{"type":"socket.close","connId":"c1","code":1006,"reason":""}
{"type":"log","level":"info","msg":"..."}
{"type":"stopped"}
```
Byte tunnel BOTH directions — length-prefixed binary records on the SAME pipe, distinguishable
from JSON because they begin with a 4-byte big-endian magic `0xDSH0001`-style header instead of `{`:
```
record := magic(u32=0x0D51_0001) | connIdx(u8) | len(u32 BE) | payload(len bytes)
payload = raw bytes exactly as they crossed the browser WS (text OR binary frame payload)
```
JSON lines are used when the first byte is `{`; binary record otherwise. Host side reads the
upgraded Duplex and shovels every post-handshake… wait — there IS no host-side handshake: the
helper does it. So host pipes from the FIRST byte: client bytes → binary records connIdx→helper;
helper records → written raw back down the socket. `socket.attach` must precede any bytes.
One helper serves one conn at a time in v1 (refuse extra attach with `error`) — multi-tab is M3.

Rationale: base64-in-NDJSON was rejected for the socket leg because piped raw bytes keep
latency and CPU lower and the framing is trivial; all OTHER audio (browser-leg JSON frames,
ElevenLabs payloads) stays inside the tunnel untouched — the helper owns it end-to-end.

## 4. Orchestrator internals (voice.orchestrator)

FSM: `disconnected → ready → listening → thinking → speaking` (+ `muted` overlay flag).
Transitions driven by stt events, intent lifecycle, tts events. Illegal transitions logged, never thrown.

Intent router: ONE fast `llm.stream` call. System prompt lists verbs; user content = transcript.
Required strict JSON output:
```
{"verb":"create_thread|message_thread|status|interrupt|summarize|speak_only|route_current",
 "threadTitle?":string,"text?":string,"ack":string}   // ack = short spoken acknowledgement template
```
Parse failure ⇒ `route_current` with raw transcript. Never block on router >2 s: timeout ⇒ ack
"Working on it" + route_current.

Verb execution mapping (exact services, verified signatures):
- create_thread → `agentLoop.createAgent(ownerCtx,{...})` (options shape verified at build time);
  title from threadTitle or first words of text; auto-send initial message when `text` present.
- message_thread → locate agent (`agents.get(id)` resolved from ThreadManager registry) → inbox
  insert/followup via `subagents.followup` for continuable children, else sessions API.
- status → `agents.list()` + `agent.status` cache + `sessionQuery.readTitleSnapshots`.
- interrupt → `subagents.interrupt(sessionId, authority)`.
- summarize → `sessionQuery.readSession(id)` tail fold → speak_only.
- speak_only → SpeakQueue direct.
- route_current → insert as user message into bound "current" thread (default: most recent active
  thread in the focused workspace; fallback creates one).

ThreadManager registry (in-memory, rebuilt lazily from sessionQuery after restart):
`Map<sessionId,{title,status,lastActivity,watching}>`. Watching starts on create/message/interrupt;
Event subscriptions (process-wide, once): `agent/status`, `agent/error`, `agent/turn-stopping`,
`subagent/end`, `goal/changed` → SpeakQueue announcements (priority 2) when watching, throttled
≥8 s apart, auto-speak off switch respected.

SpeakQueue: priority classes 0 user-reply / 1 lifecycle ack / 2 status / 3 ambient.
Higher priority preempts lower (barge-in); same class coalesces within 1.5 s window; class ≥2
drops if >3 queued. All entries also mirrored to captions history ring (last 50, memory only).

RPC methods (host `harness.handle`, all JSON): `voice.handshake`, `voice.state.get`,
`voice.listen.start/stop` (PTT entry), `voice.tts.say{text}` (debug), `voice.threads.list`,
`voice.thread.create{title?,text?}`, `voice.thread.message{id,text}`, `voice.thread.interrupt{id}`,
`voice.history.recent`, `voice.config.get/set{patch}`, `voice.diag.ping`.
Dynamic Tool `voice_say{text,priority?}` registered process-wide so ANY thread can announce.
Command `/voice <on|off|status|say …>` via `commands.register`.
Settings namespace `voice`: {enabled:true, mode:'ptt'|'always'(v1 ptt), voiceId:string,
ttsModel, sttModel, sttLanguage?, vadSensitivity:0-1, dailyCreditCap?:number,
autoSpeakReports:true, hotkey:string}. Credentials ref key `elevenlabs.api_key`.

## 4b. RPC transport (AMENDED round 8 — binding)
voice.* RPC rides plain JSON-over-HTTP on the harness origin, NOT package-private host.call:
  POST /__dsh-voice/rpc/<method>   body = JSON args   → JSON result
Client uses same-origin fetch. Method names/args/results unchanged from §4.
Non-2xx carries {ok:false,error:{code,message}}; handler errors are 200 {ok:false,error:{code:'handler_error'}}.

## 5. Client UI (voice.client)

Slots (all additive; verified against live tree):
- `shell.overlay` id 'dsh-voice-pill': collapsed pill bottom-right (state dot, level meter bars
  from mic RMS / speaking pulse, last caption snippet); click expands panel (threads list w/
  status chips + interrupt buttons, captions history, PTT button, mute, settings link).
- `sidebar.footer.action` id 'dsh-voice-toggle': mic icon toggle (global connect/disconnect).
- `conversation.input.left` id 'dsh-voice-ptt': push-to-talk button bound to CURRENT session
  (hold = listen, release = commit).
- `settings.section` id 'voice': full page — key status + guided entry (authorization flow),
  mode toggle, voice/model selects, VAD slider, credit cap, diagnostics.
Styles via `styles.insert` + theme CSS variables only; no document.body manipulation.
Mic capture probe order: getUserMedia → AudioWorklet (fallback ScriptProcessor) → 16k resample
(AudioContext sampleRate:16000 where supported, else linear resample in worklet).
Playback: single AudioContext, mp3 chunks decoded via decodeAudioData queued gaplessly per
utterance id; cancel = stop sources of that id.

## 6. Acceptance criteria (M1 gate)

- Hold PTT → speak → ≤1.2 s after release: pill shows committed transcript; ≤2.5 s: audible ack.
- Utterance "start a thread that fixes X" creates a REAL visible session in the sidebar and the
  ack names it; its completion produces a spoken report without further input.
- Tab reload mid-session reconnects cleanly; killing helper mid-utterance degrades to captions
  with error toast, recovers on next utterance.
