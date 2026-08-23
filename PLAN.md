# deepseek-voice-mode — Production Plan

An always-on voice layer for the DeepSeek Harness: you talk, it dispatches work to real harness
threads (agents/subagents/workflows), threads report back, and the harness speaks to you.
Codex-desktop-style voice mode, but harness-native — voice is an input modality + announcer over
the existing Cordis runtime, never a parallel agent brain.

Companion file: [RESEARCH.md](./RESEARCH.md) — verified facts this plan stands on.

---

## 1. Product definition

### Core loop
1. User speaks (push-to-talk v1; hands-free behind a setting later).
2. Speech → text via ElevenLabs **Scribe v2 Realtime** (host-side WS).
3. A fast intent step (harness `llm.stream`, small prompt, strict JSON out) classifies the
   utterance into a **verb** (`create_thread`, `message_thread`, `status`, `interrupt`,
   `summarize`, `speak_only`, `route_to_thread`…).
4. The orchestrator executes the verb against REAL harness primitives (agentLoop, sessions,
   subagents, jobs) and immediately queues a short spoken ack ("Starting a thread for that now").
5. Long work proceeds in visible threads. The orchestrator listens to harness Events
   (`agent/status`, `subagent/end`, `goal/changed`, `approval/request`…) and speaks concise,
   prioritized updates as they happen ("Thread 'fix flaky tests' finished — 3 files changed,
   all green").
6. Everything said is also written: live captions in the UI and durable notes in the session log.

### Non-goals for v1
- No wake-word / far-field DSP (hotkey + click first).
- No Speech Engine dependency (needs public URL; wrong shape for proactive announcements).
- No new persistence layer — state lives in harness services (sessions log, settings, credentials).

## 2. Architecture

```
┌─ Browser (client plugin) ─────────────────────────────────────────────┐
│  VoicePill (shell.overlay): state, level meter, partial transcript    │
│  mic capture → AudioWorklet 16k mono PCM16 → local WebSocket ────────┼──┐
│  playback queue (mp3 chunks → AudioContext), barge-in duck/stop      │  │
└───────────────────────────────────────────────────────────────────────┘  │
                                                           WebSocket route │ (webServer.registerUpgrade)
┌─ Host (dynamic plugins on the running harness) ───────────────────────┐  ▼
│  voice.transport: frames browser ⇄ voice-link helper (stdio JSON+PCM) │
│  voice.orchestrator:                                                  │
│    · VoiceSession FSM (idle/listening/thinking/speaking)              │
│    · IntentRouter (llm.stream, JSON-schema verbs)                     │
│    · ThreadManager: create/message/interrupt/watch via agentLoop,     │
│      sessions, subagents; watches Events for report-backs             │
│    · SpeakQueue: priorities, coalescing, interruption                 │
│    · RPC surface for client (harness.handle) + `voice_say` model Tool │
│  voice.link (child process, Node, spawned via subprocess/jobs):       │
│    · Scribe v2 Realtime STT socket (pcm_16000, VAD commit)            │
│    · TTS stream-input socket (eleven_flash_v2_5 → base64 mp3)         │
│    · owns ELEVENLABS_API_KEY — key NEVER leaves host side             │
└───────────────────────────────────────────────────────────────────────┘
        │ outbound WSS only                        ▲ events/RPC
        ▼                                          │
   api.elevenlabs.io                     rest of the harness (threads, tools, goals)
```

**Why a helper process:** verified constraint — dynamic host-plugin code has no `WebSocket`/`fetch`
builtins. The helper is a ~300-line Node script owned by the plugin Fiber (killed on stop/update),
speaking length-prefixed JSON over stdio. When the feature is promoted to a static composition row
(real package in the deployment), the same protocol moves in-process unchanged.

**Why not Speech Engine as primary:** its `sendResponse()` must run inside the `onTranscript`
handler — chat-turn-shaped. Our answers are often late + proactive. It stays an optional future
adapter (`VoiceTransport` interface) for "live phone-call" mode if wanted.

## 3. Latency budget (target vs OpenAI Realtime feel)

| Stage | Budget |
|---|---|
| end-of-speech detect (Scribe VAD commit) | ≤ 400ms |
| intent classify (small model, short ctx) | ≤ 500ms |
| spoken ack queued → first audio byte (flash TTS) | ≤ 250ms |
| **perceived ack total** | **≤ 0.9–1.2s** |
| first real content word (LLM TTFT dependent) | ≤ 2.5s typical |

Tactics: speak acks from canned templates (zero LLM latency); stream intent output; start TTS on
first sentence boundary, not paragraph end; barge-in cancels playback + aborts in-flight LLM call.

## 4. Workstreams → subagents

All implementation subagents get RESEARCH.md + this file, must Inspect-query exact contracts before
writing code, use plain-JS dynamic packages (no TS/JSX/imports), lifecycle-safe effects only.

| # | Subagent | Deliverable |
|---|---|---|
| W1 | **voice-link** | Node helper proc: Scribe + TTS sockets, stdio framing protocol doc, reconnect/backoff, unit-testable pure modules. Runs standalone with `ELEVENLABS_API_KEY`. |
| W2 | **orchestrator** | Host plugin: transport service (upgrade route ⇄ helper), FSM, intent router, thread manager, speak queue, RPC surface, `voice_say` tool, `/voice` command, settings ns. |
| W3 | **client-ui** | Client plugin: probe browser globals; overlay Pill + expandable panel (threads, captions, controls); sidebar toggle; composer mic button; styles via theme vars. Basic but tasteful. |
| W4 | **integration** | Probe packages FIRST (see M0); then end-to-end wiring, latency instrumentation, failure drills (tab close, key invalid, helper crash), repair loops. |

Sequencing: W4's probes → W1 ∥ W3 → W2 (needs W1 protocol frozen) → integration pass.

## 5. Milestones

- **M0 — Probes (tiny throwaway packages, needs API key):**
  client globals reachable? `registerUpgrade` handler shape? `subprocess.spawn` contract?
  `web.fetch` streaming? ElevenLabs key valid; one-shot Scribe round-trip + flash TTS clip.
- **M1 — Walkie-talkie:** hold-to-talk → caption shows committed transcript → routes to current
  thread as a normal message → reply spoken. Instrument every stage.
- **M2 — Orchestration:** verb set live (create/status/interrupt/message/report), SpeakQueue with
  priorities + barge-in, `voice_say` tool so any thread can announce, overlay thread cards.
- **M3 — Always-on + polish:** background listening setting, reconnect resilience (page reload,
  helper restart), settings page (key flow, voice/model, VAD sensitivity, budget cap), approval
  announcements, then a dedicated UI/UX polish pass (impeccable skill).

## 6. Risks & mitigations
- Browser-global restrictions on client half → M0 probes before anything leans on them.
- registerUpgrade shape unknown → probe; fallback: poll-free SSE-ish chunked route or short-poll
  JSON RPC for control + separate upgrade attempt for audio.
- Scribe VAD tuning (chatty environments) → manual-commit fallback + sensitivity setting.
- Cost runaway → per-day credit cap in settings; TTS only after ack-worthy events (coalescing).
- Dynamic-plugin lifetime vs "always-on": host service lives as long as the DSH process; browser
  leg reconnects automatically when tab returns.

## 7. Open items for user
- ElevenLabs API key (credentials service, host-side only).
- Preferred voice_id + default workspace behavior (v1 defaults fine).
