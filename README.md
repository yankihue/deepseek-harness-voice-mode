# deepseek-voice-mode

Always-on voice layer for the DeepSeek Harness (DSH): speech in/out via
**ElevenLabs**, dispatching to **real harness threads** — never a parallel
agent brain. Talk to your agent, start/summarize/interrupt threads by voice,
and have threads report back aloud.

> **Status: beta (v0.1.0-beta.1).** Working end-to-end and covered by 100
> offline tests, but still a manual-install, single-user build. See
> [Known limitations](#known-limitations) before relying on it.

## What it does

- **Browser UI** (static client module): mic → AudioWorklet → 16 kHz mono PCM
  over a WebSocket; spoken announcements stream back as MP3.
- **Host orchestrator** (static Cordis composition plugin):
  - HTTP JSON RPC `POST /__dsh-voice/rpc/<method>` (control plane)
  - WS route `/__dsh-voice/ws?t=<one-time-token>` (data plane)
  - Intent router — deterministic lifecycle commands first, then one bounded
    low-reasoning `llm.stream` call → strict JSON verb
  - Thread manager — create / message / interrupt / summarize / watch real
    harness sessions (`agents`/`subagents`/`sessionQuery`)
  - Speak queue — priority preemption, coalescing, drop caps, caption mirror
- **`voice-link` helper** (dependency-free Node ≥ 22 subprocess):
  ElevenLabs Scribe v2 realtime STT (VAD commit), stream-input TTS
  (`eleven_flash_v2_5`), and a self-contained RFC 6455 implementation.

ElevenLabs sockets are outbound-only from the helper; the API key resolves
from the harness credentials service at spawn and **never reaches the
browser**.

## Repository layout

```
deepseek-voice-mode/
  README.md                     ← you are here
  PLAN.md PROTOCOL.md RESEARCH.md STATUS.md REVIEW.md   (design + round docs)
  voice-link/                   helper subprocess (entry/wsio/bridge/stt/tts)
    test/                       offline unit/integration tests (node --test)
    m0-driver.js                dev tool: live E2E drill (needs a real key)
  packages/orchestrator/        host plugin: host.js (source) → plugin.cjs
                                (generated static wrapper) + INTEGRATION.md
  packages/client/              browser UI: lib/client.js (deployed bundle),
                                lib/index.js, package.json, UI-NOTES.md
```

## Requirements

- Node.js **≥ 22** (the helper is dependency-free — no `npm install` needed)
- A DeepSeek Harness deployment exposing `webServer`, `credentials`,
  `subprocess`, `settings`, `commands` (and, for voice-driven threads,
  `agents`/`subagents`/`sessionQuery`/`llm`)
- An **ElevenLabs API key** (STT+TTS usage consumes ElevenLabs credits)

## Install

The full install recipe lives in `REVIEW.md` §6. Short version:

1. Clone this repo anywhere and note its **absolute path** (`<ABS>`).
2. Append to `~/.dsh/profiles/web/cordis.patch.yml`:
   ```yaml
   - insert:
     - id: deepseek-voice-mode
       name: <ABS>/packages/orchestrator/plugin.cjs
     - id: deepseek-voice-mode-ui
       name: deepseek-voice-mode-ui
   ```
3. Symlink the client package into the profile:
   ```sh
   mkdir -p ~/.dsh/profiles/web/node_modules && \
   ln -s <ABS>/packages/client ~/.dsh/profiles/web/node_modules/deepseek-voice-mode-ui
   ```
4. Put your key in `~/.dsh/.credentials.yaml`:
   ```yaml
   refs: { ELEVENLABS_API_KEY: sk_... }
   ```
5. Restart the profile; watch for `[voice.orchestrator] activated`.

**Rollback:** remove the insert block + symlink and restart.

## Usage

Full user manual: `REVIEW.md` §5. The essentials:

- **Sidebar bottom-left mic button** = power. Off means no helper process and
  zero ElevenLabs usage.
- **Bottom-right pill** = status; click to open the panel (threads with
  interrupt, captions history, ambient-listening toggle, power row).
- **Push-to-talk**: press the composer 🎙 (or your configured hotkey) once to
  start listening; speak; pause → the transcript commits.
- **`/voice on|off|status|say <text>`** text command always works.
- Spoken verbs: *"start a thread that …"*, *"what's running?"*, *"stop
  <thread>"*, *"summarize <thread>"*; anything else falls through to your
  current thread as a normal message. Watched threads report back aloud.
- Explicit create/status/stop commands route locally without a model call.
  Ambiguous requests use the selected Harness model with low reasoning and an
  8-second deadline. Captions and `voice.diag.ping` expose the chosen verb and
  `timeout`, `invalid_json`, `model_error`, or `model_unavailable` fallbacks.

## Configuration

Settings namespace `voice` (Settings → Voice): enabled, push-to-talk mode,
ElevenLabs voice/model ids, STT language, VAD sensitivity, optional daily
credit cap, auto-speak reports, and hotkey. The helper is resolved from the
installed plugin directory; no machine-specific path setting is required.

## Development

```sh
cd voice-link
node --test          # 100 offline tests, ~2 s, no network needed
```

`node voice-link/m0-driver.js <pcm16-16k-mono.raw> "expected transcript"`
runs a live browser-less E2E drill against real ElevenLabs (needs
`ELEVENLABS_API_KEY` in env; writes `/tmp/m0-out.mp3`).

## Known limitations (beta)

- **One browser connection at a time** (v1 design, PROTOCOL §3).
- **Requires an ElevenLabs API key**; STT/TTS usage spends ElevenLabs credits
  (no hard cost gate yet — `dailyCreditCap` is optional).
- **Manual install** into a DSH profile (patch + symlink + restart); not yet
  published to npm.
- One-time WS tokens use deterministic entropy (H3 in `REVIEW.md`); settings
  schema upgrades are fragile (H5). See the hack register in `REVIEW.md` for
  the full H1–H12 list.

## Documentation

| Doc | Content |
|---|---|
| `PROTOCOL.md` | Frozen v1 wire protocol (tunnel, WS, RPC) |
| `PLAN.md` / `RESEARCH.md` / `STATUS.md` | Design + round-by-round state |
| `REVIEW.md` | Peer review, install recipe, caveats, hack register |
| `voice-link/DEVIATIONS.md` / `README.md` | Helper deviations + details |
| `packages/client/UI-NOTES.md` | Client component/state notes |
| `packages/orchestrator/INTEGRATION.md` | Host service integration + VERIFY registry |

## License

[MIT](LICENSE) — Copyright (c) 2026 yankihue.
