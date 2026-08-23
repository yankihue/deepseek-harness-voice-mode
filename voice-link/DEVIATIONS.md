# DEVIATIONS from PROTOCOL.md (voice-link W1)

PROTOCOL.md is frozen; when the frozen spec could not be implemented literally,
the deviation below explains why and what was built instead. This file also
records the reconciliation with the W2 orchestrator contract
(`packages/orchestrator/INTEGRATION.md` §4), which is NORMATIVE for the helper
side. Everything not listed here follows PROTOCOL.md exactly.

## W2 reconciliations (normative: INTEGRATION.md §4)

The following changed AFTER the first W1 pass when the orchestrator host half
landed; each entry names the conflict with PROTOCOL.md and the resolution.

## D11. connIdx 1 = connId 'c1' on the byte tunnel

- **Spec:** PROTOCOL §3 defines the record header (`connIdx(u8)`) but leaves
  the numbering open; the original W1 draft used a 0-based insertion order.
- **Normative:** host.js uses `CONN_IDX = 1` (INTEGRATION §4.1) and drops any
  record whose connIdx doesn't match its attached conn (host.js
  `handleTunnelRecord`). The helper now adopts the connIdx of the first
  inbound record for its single connection (default `1`) and echoes it on
  every outbound record (`Bridge.connIndex`, `feedRecord`).

## D12. Bare-JSON '{'-initial records, not framed WS payloads

- **Spec:** PROTOCOL §3 says the helper "records → written raw back down the
  socket", implying complete wire bytes both ways; the original draft sent
  browser-bound text messages as complete (unmasked) WS text frames.
- **Normative:** INTEGRATION §4.3/§4.5 + host `relayBytes`: host-injected
  control frames (`listen.start/stop`, `tts.speak`, `tts.cancel`) arrive as
  tunnel records whose payload is BARE JSON (first byte `'{'`); and the host
  wraps any `'{'`-initial helper record into a WS text frame for the browser.
  The helper therefore:
  - parses `'{'`-initial inbound records directly as browser-style control
    messages (trusted channel — no masking, no hello gate, see D14);
  - emits every browser-bound text message (`ready`, `session.state`,
    `stt.*`, `tts.*`, `pong`, `error`, `tts.error`) as a BARE JSON record;
  - still emits complete framed bytes only for raw control traffic (the `101`
    handshake response, close frames, WS pong echoes), which the host relays
    verbatim.
  The `'{'` discriminator is safe on the browser leg because client frames are
  masked (payload bytes are XOR-encrypted on the wire), so a raw socket chunk
  can only start with `'{'` at an unmasked boundary — which the framing model
  here never produces.

## D13. TTS failures emit type 'tts.error' (with id)

- **Spec:** PROTOCOL §1 lists only the generic S→C `error` frame; the original
  draft sent TTS failures as `{type:'error', code:'tts_*'}`.
- **Normative:** host.js `peekWsFrame` advances the SpeakQueue only on
  `tts.audio{done:true}`, `tts.canceled{id}`, or a frame with `type ===
  'tts.error'` for the active utterance (INTEGRATION §4.6). The generic
  `error` frame only pushes a caption. The helper now emits
  `{type:'tts.error', id, code:'tts_auth|tts_net|tts_proto', message}` — an
  additive S→C type. The generic `error` frame is still used for session-level
  failures (hello rejection `auth`, WS protocol `proto`).

## D14. Host-injected controls bypass the hello gate

- **Spec:** PROTOCOL §1 "helper also refuses to start session without a valid
  hello" — originally applied to every message.
- **Normative:** the host pumps the SpeakQueue as soon as a conn is attached
  (host.js §C.2/D3 — no browser hello required, e.g. the V2 no-browser ack
  path), so gating injected `tts.speak` on hello would hang the queue forever.
  Resolution: browser-originated messages (masked frames) still require a
  valid hello; host-injected bare-JSON records (listen.*/tts.*) are trusted
  (the host already validated the one-time token during upgrade dispatch) and
  process immediately. Hello itself is only ever accepted from the browser
  channel with token/proto validation.

## D1. STT auth header vs Node's global WebSocket

- **Spec:** PROTOCOL §2 — "auth via API key header".
- **Problem:** Node 22's global `WebSocket` (undici) implements the WHATWG
  constructor `new WebSocket(url, protocols?)` and **cannot set request
  headers**. The verified ElevenLabs API reference states STT auth is "either
  by providing a valid API key in the `xi-api-key` header or … a `token` query
  parameter" — there is no key-in-first-message option for Scribe realtime.
- **Built:** `wsio.connectOutbound()` — a minimal RFC6455 client using
  `node:https` upgrade + `node:crypto`, exposing the same
  onopen/onmessage/onclose/onerror/send/close surface so stt/tts remain
  testable with fakes. `entry.js` wires it as the real `connect` factory for
  **both** STT and TTS (uniform code path; TTS also sends the key in its first
  message, satisfying both documented auth styles).
- **Impact:** none on the stdio or browser-leg protocols.

## D2. TTS first-frame auth sent under both key spellings

- **Spec:** PROTOCOL §2 — "First frame: voice_settings + generation_config
  (chunk_length_schedule:[120,160,250,290]) + auth".
- **Detail:** the live docs guide sends `"xi_api_key"` (underscore) in the
  first message, while the AsyncAPI reference schema names the property
  `xi-api-key` (hyphen). To be safe against either parsing, `tts.js` sends the
  key under **both** keys in the init frame. Harmless, documented in README.

## D3. Extra host-leg control message `error`

- **Spec:** PROTOCOL §3 lists Helper→Host controls `ready`,
  `socket.open/close`, `log`, `stopped` only; §1 semantics say a second attach
  is "refuse[d] with error" without defining the message.
- **Built:** on a refused second `socket.attach`, the helper emits
  `{"type":"error","code":"busy","connId":…,"message":…}` (JSON line) and drops
  that conn's bytes. The host may use it to close the orphan socket.
- **Impact:** additive; existing host parsing of the §3 list is unaffected.

## D4. Missing API key short-circuits to auth error

- **Spec:** none (key source: env).
- **Built:** if `ELEVENLABS_API_KEY` is absent, `listen.start` / `tts.speak`
  emit `stt_auth` / `tts_auth` immediately **without attempting a network
  connection** (which would fail with a server-side 401 anyway). This is also
  what makes the helper fully runnable/testable offline.

## D5. Voice/model selection via environment

- **Spec:** PROTOCOL §2 names the endpoint `{voiceId}` and model, but the
  browser messages (`tts.speak {id,text}`, `listen.start`) and init line carry
  **no channel** for `voiceId`/model.
- **Built:** `ELEVENLABS_VOICE_ID` (required for TTS), `ELEVENLABS_TTS_MODEL`
  (default `eleven_flash_v2_5`), `ELEVENLABS_STT_MODEL` (default
  `scribe_v2_realtime`) as env vars, mirroring the key-source pattern. If a
  future protocol bump adds per-message fields they override env.

## D6. Non-auth Scribe error families map to `stt_proto`

- **Spec:** PROTOCOL §2 defines exactly three codes (`stt_auth`, `stt_net`,
  `stt_proto`).
- **Built:** Scribe's `quota_exceeded`, `rate_limited`, `resource_exhausted`,
  `input_error`, `invalid_request`, `chunk_size_exceeded`,
  `insufficient_audio_activity`, `commit_throttled`, `transcriber_error`, …
  all map to `stt_proto` (with the server's message text) and end the session.
  `auth_error`/`unaccepted_terms` → `stt_auth`. Network-level symptoms
  (HTTP non-101, close 1006, connect failure) → `stt_net`.

## D7. STT session lifecycle is per-listen

- **Spec:** "STT (per listen session)".
- **Built:** `listen.stop` flushes a final commit then **closes** the Scribe
  socket; a later `listen.start` opens a fresh session. This avoids committing
  state bleeding across utterances and matches "reconnect = new hello" on the
  browser side.

## D8. Reconnect audio continuity is best-effort replay

- **Spec:** PROTOCOL §2 — "Reconnect with backoff on close".
- **Built:** STT audio arriving while a reconnect is in progress is buffered
  (≤4 MB, checksums not tracked) and replayed as PCM on the healthy socket —
  idempotent for the server. No partial-transcript carry-over: transcripts
  from the dead session are simply lost (each listen is a fresh Scribe session).
  A single `stt_net` error is emitted per outage episode, not per retry.

## D9. Heartbeat counts any inbound frame as liveness

- **Spec:** "client pings every 15 s; helper closes dead peers after 30 s
  silence". "Silence" is read as *no inbound bytes at all*: mic audio also
  keeps a peer alive; `ping` → `pong` is still answered with the echoed `ts`.

## D10. TTS mixer is "latest active utterance" for cancel-without-id

- **Spec:** §1 semantics: `tts.cancel` without id = "cancel current utterance";
  the queue itself lives host-side.
- **Built:** with several concurrent TTS sockets (parallel `tts.speak`), the
  helper cancels the **most recently started** active utterance. `tts.canceled`
  is only emitted for utterances the helper actually aborted.