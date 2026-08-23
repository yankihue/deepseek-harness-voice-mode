# voice-link — the deepseek-voice-mode helper process

Standalone, **zero-dependency** Node ≥ 22 process that owns **all WebSocket work**
for the voice feature: the browser-leg RFC6455 connection (host plugin code has
no crypto/WS builtins) and the outbound ElevenLabs Scribe-v2-realtime STT +
stream-input TTS sockets. Key handling happens only here; the key never leaves
the host side and is never logged or persisted.

```
Browser page                     Host plugin                      voice-link (this dir)
┌──────────────┐  WebSocket ───────────────────────┐  stdio NDJSON + byte-tunnel  ┌───────────────┐
│  mic PCM16   │◄─────────────────────────────────►│ voice.transport ─────────────►│  entry.js     │──► Scribe STT (WSS)
│  playback    │  ws://127.0.0.1:<port>/__dsh-voice/ws  (raw bytes piped)   │  tunnel/wsio │──► stream-input TTS (WSS)
└──────────────┘                                   └───────────────────────┘  bridge/stt/tts│
                                                                          └───────────────┘
```

Protocol contract: [`PROTOCOL.md`](../PROTOCOL.md) (§1 browser WS, §2 ElevenLabs,
§3 host⇄helper stdio). Verified API facts: [`RESEARCH.md`](../RESEARCH.md).
Any intentional divergence: [`DEVIATIONS.md`](./DEVIATIONS.md).

---

## 1. Running it

The host spawns the helper with pipes, exactly like:

```sh
ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... node entry.js
```

* `stdin` — host → helper: control JSON lines + byte-tunnel records (below).
* `stdout` — helper → host: control JSON lines + byte-tunnel records (below).
* `stderr` — free-form human diagnostics (`[voice-link] level: msg`).
* Exit code 0 after a clean `stop`, 1 on fatal startup failure.

### Boot sequence

1. Helper reads the **first** stdin line — must be
   `{"type":"init","proto":1,"logLevel":"info"}` (proto `1`, else it refuses to
   start). `logLevel` ∈ `debug|info|warn|error` (default `info`).
2. Helper answers `{"type":"ready","proto":1,"pid":<pid>}`.
3. Helper serves `socket.attach`/`socket.detach`/byte records until
   `{"type":"stop"}` or stdin EOF, then writes `{"type":"stopped"}` and exits.

## 2. stdio framing (PROTOCOL.md §3 + orchestrator INTEGRATION.md §4)

One pipe pair carries two record kinds, told apart by the first byte:

* **JSON control lines** — begin with `{`, UTF-8, newline-delimited.
* **Binary byte-tunnel records** — begin with the 4-byte BE magic
  `0x0D51_0001`: `magic(u32 BE) | connIdx(u8) | len(u32 BE) | payload(len)`.

**connIdx (W2 convention):** the v1 single connection `c1` rides **connIdx 1**
(`socket.attach` carries `connId:'c1'`). The helper adopts whatever connIdx the
host uses on the first inbound record for its single connection (defaults to 1)
and echoes it on every outbound record — the host drops records whose connIdx
does not match its attached conn.

**Record payload semantics (INTEGRATION §4.3–§4.5):**

* Host → helper records: the reconstructed HTTP upgrade request first, then
  browser socket bytes (masked WS frames) **verbatim**, and host-injected
  browser-style messages (`listen.start`, `listen.stop`, `tts.speak`,
  `tts.cancel`) as **bare JSON text** (starts with `'{'`). The helper treats
  `'{'`-initial records as if they arrived from the browser as WS text frames
  (on a trusted channel: no masking, no hello gate).
* Helper → host records: browser-bound **text messages are emitted as bare
  JSON** (starts `'{'`) — the host wraps them into WS text frames for the
  browser and peeks them for `stt.*`/`tts.*`/`session.state` to drive its FSM.
  Raw framed WS messages (the `101` handshake response, close/pong control
  frames) are emitted as complete WS frame bytes and relayed verbatim.

`socket.attach` must precede any bytes for that conn; the helper answers the
handshake itself (SHA-1 accept via `node:crypto`).

### Host → helper (stdin)

```jsonc
{"type":"init","proto":1,"logLevel":"info"}               // first line, always
{"type":"socket.attach","connId":"c1","url":"/__dsh-voice/ws?t=<token>"} // bytes follow via tunnel
{"type":"socket.detach","connId":"c1"}
{"type":"stop"}
```

### Helper → host (stdout control lines)

```jsonc
{"type":"ready","proto":1,"pid":1234}
{"type":"socket.open","connId":"c1"}                      // upgrade accepted (101)
{"type":"socket.close","connId":"c1","code":1006,"reason":""}
{"type":"log","level":"info","msg":"..."}                 // warn/error only
{"type":"error","code":"busy","connId":"c1","message":"..."} // added: refused 2nd attach
{"type":"stopped"}
```

`log` control lines are emitted for `warn`/`error` only; `debug`/`info` go to
stderr (respecting the init `logLevel`).

## 3. Browser ⇄ helper WebSocket (PROTOCOL.md §1)

The helper parses the HTTP upgrade request itself (accept key via `node:crypto`
SHA-1), answers `101`, then speaks RFC6455. All browser-leg messages:

| Direction | Message |
|---|---|
| S→C | `{type:'ready', proto:1}`, `{type:'session.state', state}`, `{type:'stt.partial'\|'stt.committed'\|'stt.error', …}`, `{type:'tts.start'\|'tts.audio'\|'tts.canceled', …}`, `{type:'tts.error', id, code, message}` (additive: host queue terminal), `{type:'pong', ts}`, `{type:'error', code, message, fatal?}` |
| C→S | `{type:'hello', token, proto:1}`, `{type:'listen.start', commit:'vad'\|'manual', language?}`, `{type:'listen.stop'}`, `{type:'tts.speak', id, text}`, `{type:'tts.cancel', id?}`, `{type:'ping', ts}` |
| C→S bin | raw 16 kHz mono s16le PCM mic audio |

Security/robustness rules implemented here:

- **hello gate**: the token from the attach URL (`?t=…`) must be echoed in
  `hello`; browser-originated messages (and mic audio) are not processed before
  a valid hello. Wrong token/proto or a re-hello ⇒
  `error{code:'auth', fatal:true}` + close. Host-injected controls (the trusted
  tunnel channel) bypass this gate (see DEVIATIONS D14).
- **exact-once terminals**: for every accepted `tts.speak`, exactly ONE of
  `tts.audio{id, done:true}` / `tts.canceled{id}` / `tts.error{id, …}` is
  emitted for that id — never twice, never audio after cancel (host SpeakQueue
  advance, INTEGRATION §4.6).
- **heartbeat**: `ping` → `pong` echo; a peer silent for **>30 s** is closed
  (heartbeat frame sent, socket torn down); checks run every 5 s.
- **barge-in**: `tts.cancel` (with or without id) aborts the socket send side of
  the target utterance and stops emitting audio for it; `tts.canceled` is sent.

## 4. Environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `ELEVENLABS_API_KEY` | yes* | — | ElevenLabs key. Missing ⇒ immediate `stt_auth`/`tts_auth` errors, never a network attempt. Never logged. |
| `ELEVENLABS_VOICE_ID` | yes* | — | TTS voice id (the frozen protocol defines no channel for it — see DEVIATIONS). |
| `ELEVENLABS_TTS_MODEL` | no | `eleven_flash_v2_5` | stream-input model. |
| `ELEVENLABS_STT_MODEL` | no | `scribe_v2_realtime` | Scribe realtime model. |

\* The helper still boots without them and reaches `ready`; only STT/TTS work
fails with the matching auth error.

## 5. ElevenLabs integration (PROTOCOL.md §2)

**STT** — `Scribe v2 Realtime`:
`wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=…&audio_format=pcm_16000&sample_rate=16000&commit_strategy=vad|manual[&language_code=…]`,
auth via `xi-api-key` header, audio as `{"message_type":"input_audio_chunk",
"audio_base_64":…,"commit":false,"sample_rate":16000}`.
Per listen session; **manual or VAD commit**; **force-commit when >20 s
(640 KB) of audio streams without a commit** (the model force-commits ~36 s;
we stay ahead). `listen.stop` flushes a final commit then closes the socket.
**Reconnect with backoff** `[0.5s,1s,2s,4s,8s]` on unplanned close; audio fed
while down is buffered (≤4 MB) and replayed idempotently on reconnect (PCM).
Auth failures never retry.

**TTS** — stream-input WS per utterance:
`wss://api.elevenlabs.io/v1/text-to-speech/<voiceId>/stream-input?model_id=<model>`.
First frame carries `voice_settings` + `generation_config` with
`chunk_length_schedule:[120,160,250,290]` + the key (both `xi_api_key` and
`xi-api-key` spellings — see DEVIATIONS). Text is chunked at **sentence
boundaries ≤200 chars** (CJK-aware); each `{audio}` response streams as
`tts.audio`; `isFinal` fires `tts.audio{done:true}`; an empty-string frame ends
input. `tts.cancel` aborts without flushing.

### Error codes (exact, per PROTOCOL §2)

| Code | Meaning | Triggered by |
|---|---|---|
| `stt_auth` | bad/missing key, auth_error, 4001/4002/4003 closes | Scribe `auth_error`/`unaccepted_terms`, close 4001–4004/4401–4404, missing env key |
| `stt_net` | socket died (1006/timeout), connect failure | unrecoverable-transport closes |
| `stt_proto` | 1002, bad JSON, other server errors (quota, rate_limited, input_error, …) | Scribe error family |
| `tts_auth` | bad/missing key, 4001/4002/4003 closes | stream-input close codes |
| `tts_net` | socket died (1006/timeout) | transport failures |
| `tts_proto` | 1002, non-JSON message, no voiceId configured | protocol violations |

STT failures surface on the browser socket as `{type:'stt.error', code:'stt_*', message}`;
TTS failures surface as `{type:'tts.error', id, code:'tts_*', message}` — an
additive S→C type that doubles as the host SpeakQueue terminal (INTEGRATION §4.6).

## 6. Files

| File | Contents |
|---|---|
| `entry.js` | boot sequence, stdio glue, tunnel↔bridge wiring, log levels, lifecycle |
| `tunnel.js` | byte-tunnel encode/decode + NDJSON multiplex (pure) |
| `wsio.js` | RFC6455 server handshake, frame parse/encode, header-capable outbound WS client |
| `bridge.js` | connId ↔ sessions, hello validation, heartbeat, message routing |
| `stt.js` | Scribe v2 Realtime client (reconnect/backoff, commit, force-commit, error mapping) |
| `tts.js` | stream-input TTS per utterance (chunker, init/auth frame, cancel, error mapping) |
| `test/` | `node --test` suite — fully offline (fake WebSocket + fake streams) |

## 7. Testing

```sh
node --test            # from voice-link/ — auto-discovers test/; no API key, no network
node --test "test/*.test.js"   # explicit glob (same suite)
```

> Note: on Node ≥ 21 positional args to `--test` are glob patterns, so a bare
> `node --test test/` is treated as a file path and fails with
> `MODULE_NOT_FOUND`. Use the no-arg or glob forms above.

Coverage: tunnel framing round-trips (incl. interleaved JSON+records, split
feeds), RFC6455 accept-key vector, frame round-trips (masking, fragmentation,
close codes), STT event mapping/force-commit/reconnect, TTS chunker/cancel, and
the full entry lifecycle (boot → ready → attach → handshake → hello →
mocked auth failure → stop).

## 8. Operational notes

- **One connection at a time (v1).** A second `socket.attach` is refused with
  `{"type":"error","code":"busy",…}`; multi-tab is M3. The v1 conn is `c1` on
  tunnel **connIdx 1**.
- **Clean shutdown:** `stop` / stdin EOF / SIGTERM / SIGINT tear down every
  socket, timer, and session before exiting 0. No dangling intervals.
- **Latency:** TTS starts synthesizing as soon as the first sentence chunk is
  buffered at ElevenLabs (`chunk_length_schedule` drives TTFB); STT partials
  stream straight through.
- **Host FSM requirements (INTEGRATION §4):** `ready` is always the first
  stdout line after `init`; browser-bound text messages go out as bare JSON so
  the host can peek `stt.*`/`tts.*`/`session.state`; every `tts.speak` yields
  exactly one terminal.