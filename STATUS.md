# deepseek-voice-mode — ORCHESTRATOR STATE (update every round)

Last updated: round 8 — STATIC PROMOTION. Owner: main agent (ox-alpha).
Goal: goal-de0954ea-4860-4e99-b775-0686637f9acf (armed, max 12 rounds).

## Current architecture (changed this round)
The orchestrator now ships as a STATIC host-composition plugin loaded from disk:
- Row added to /Users/yanki/.dsh/profiles/web/cordis.patch.yml (user patch layer):
  insert id 'deepseek-voice-mode' → name = ABSOLUTE path to
  packages/orchestrator/plugin.cjs (mechanically generated wrapper around host.js;
  regenerate via the python snippet in this file's history or rewrite by hand).
- RPC transport: POST /__dsh-voice/rpc/<method> (JSON args → JSON result) on the
  harness's own origin. harness.handle kept behind a typeof-check as transport B.
- Tool registration: harness pair when dynamic; ctx.get('tools').register otherwise.
- RESTART REQUIRED to load: patches apply at profile boot. Rollback = delete the
  insert block from cordis.patch.yml + restart.

## Why static now
1. Production-grade per user requirement; real files on disk, no inline payloads.
2. LLM emission of the 60KB define payload failed 3× (placeholder collapse) —
   mechanical generation is strictly safer. Dynamic defs voice-3/voice-4 undefined.
3. M0 proved the entire voice stack live through the helper already (see round 7).

## Workstreams
| ID | Scope | Status | Output |
|----|-------|--------|--------|
| W1 | voice-link helper | ✅ DONE (100/100 tests) + live-verified STT/TTS | voice-link/ |
| W2 | orchestrator host code | ✅ DONE + static-port edits (HTTP RPC, dual tool reg) | packages/orchestrator/host.js → plugin.cjs |
| W3 | client UI | RUNNING; told to switch host.call → fetch('/__dsh-voice/rpc/…') | packages/client/client.js |
| W4 | assembly/e2e | MAIN AGENT — awaiting restart + W3 | — |

## ROUND 10 — ROOT CAUSE + HOST LIVE
Static row wasn't loading for two stacked reasons, both fixed:
1. cordis treats FUNCTION module exports as koishi-style constructors — apply never runs,
   silently. plugin.cjs now exports the plugin OBJECT directly (mechanical wrapper).
2. First boot had an activation-order race → inject list now:
   ['timer','settings','credentials','subprocess','webServer','commands'].
VERIFIED on diagnostic instance (port 3199): activated log, helper spawned+ready via
credentials, diag.ping/threads.list(real corpus titles)/config.get/handshake all answer.
tts.say queues correctly (waits for conn per D3).
NOTE: user's server needs ONE more restart to load the fixed plugin.cjs (module files are
imported once at boot; patch hot-reload does not re-import entry modules).
W3 relaunched fresh (old subagent died with the process restart): c157c697.

## Power semantics (round 9 — user request)
Hard on/off wired: voice.config.set{patch:{enabled}} (and /voice on|off) now
applyPowerState(): disabled => closeConn + stopHelper + FSM disconnected
(zero processes, zero ElevenLabs connectivity); enabled => respawn helper.
W3 told: sidebar toggle = power switch; pill reflects 'disconnected'=off;
configurable in-page hotkey reads settings `hotkey` field.
Always-on mode (M3) will default to client-side VAD gating so silence is never
streamed/billed; PTT v1 already burns credits only while the button is held.

## ROUND 11 — FULL STACK VERIFIED ON DIAGNOSTIC BOOT
Client shipped as a REAL static client module (clientModules convention):
- packages/client/lib/client.js = window.__ModuleLoader__.load bundle (generated from client.js)
- packages/client/lib/index.js = empty-apply host face (shipped convention)
- package.json exports {.,./client,./package.json} ← ./package.json REQUIRED (scanner resolve)
- symlinked at profiles/web/node_modules/deepseek-voice-mode-ui; patch row name = bare specifier
VERIFIED on port 3199: host activated+helper ready+RPC ok; client bundle served;
index HTML references deepseek-voice-mode-ui/client.js. Zero boot errors.
cordis_define code param collapses LLM emission (3 strikes) — do NOT use for big payloads.
USER ACTION: restart server on 3080 → verify diag.ping → open browser → mic toggle bottom-left
sidebar, pill bottom-right → hold PTT and speak.

## Next actions after user restarts DSH
1. Verify boot log line '[voice.orchestrator] activated'; /voice status command works.
2. When W3 lands: assemble client half (dynamic package OR second static row),
   browser PTT smoke per PROTOCOL §6.
3. M1 acceptance gate; then M2 polish verbs, M3 always-on + settings UI.
4. Context-compaction insurance: all durable state lives in these .md files +
   source tree. get_goal() then resume.

## Where truth lives
- PLAN.md — architecture, milestones, risks. RESEARCH.md — verified runtime/API facts.
- PROTOCOL.md — FROZEN v1 wire protocols + component specs + M1 acceptance gate.

## Decisions locked
1. Stack: Scribe v2 Realtime STT + stream-input TTS (`eleven_flash_v2_5` default), all outbound
   from helper proc. Speech Engine = future optional adapter (public-URL constraint; callback-
   scoped sendResponse wrong shape for proactive reports).
2. Helper process owns ALL WebSocket work incl. browser-leg handshake (host has no crypto builtin);
   host pipes upgraded socket bytes verbatim over stdio (PROTOCOL §3 framing).
3. Voice-link is dependency-free Node ≥22 code (global WebSocket/crypto confirmed, node v22.23.2).
4. Voice = input modality + announcer over real harness threads; never a parallel brain.
   Fallback verb route_current guarantees nothing gets dropped.
5. Key storage: credentials service ref `elevenlabs.api_key`, passed to helper as env at spawn.

## Workstreams
| ID | Scope | Status | Output location |
|----|-------|--------|-----------------|
| W1 | voice-link helper | ✅ DONE + W2-contract reconciled (99/99 tests, D11–D14); M0 driver validated to auth wall; 1 real bug fixed (wss: scheme) | voice-link/ |
| W2 | orchestrator host plugin code | ✅ DONE round 5 — host.js 1582L parses, smoke 27/27; INTEGRATION.md has VERIFY registry V1–V23 + deviations D1–D7 | packages/orchestrator/host.js |
| W3 | client UI plugin code | RUNNING — agent 2caa9145 (only remaining build) | packages/client/client.js |
| W4 | assembly/probes/e2e | MAIN AGENT — m0-driver.js ready; blocked only on API key | voice-link/m0-driver.js |

## Decisions locked (additions from W2, round 5)
6. Dynamic plugin cannot pass its ctx façade as ownerCtx to agentLoop.createAgent (loop reads
   ownerCtx.fiber/agents/sessions) ⇒ thread creation routes through `agents.create(options)`;
   direct call kept as parity fallback behind single `createAgentOnce` site (INTEGRATION.md D1).
7. Sandbox has NO AbortController/performance/crypto: tokens from Date.now+Math.random+counter;
   all cancellation via ctx.timeout races. Helper contract: connIdx 1='c1'; injected host→helper
   control = bare-JSON tunnel payloads; helper '{' payloads relayed as WS text frames + peeked
   for stt.*/tts.*/session.state; queue advances on exactly one terminal tts event per id.
8. Settings schema registered as callable identity fn + toJSON (dsh-settings resolve calls it).
9. `helperPath` setting added (D4), default …/deepseek-voice-mode/voice-link/entry.js.

## Next actions (in order)
1. ✅ Round 7: M0 plumbing validated WITHOUT key via voice-link/m0-driver.js against live
   api.elevenlabs.io with dummy key — full path proven: spawn→init→ready→attach→WS 101
   handshake→hello→listen.start→Scribe connect→server auth_error→mapped stt_auth→stt.error
   delivered→FSM idle. Found+fixed REAL helper bug: node:http(s) rejects wss: URLs
   (wsio.connectOutbound now scheme-normalizes wss:→https:, tests still 99/99).
   Fixture chain ready: say → afconvert → /tmp/m0.raw (2.9s speech PCM16k mono).
   Driver quirks fixed: init line must be sent; upgrade bytes precede socket.open wait.
2. ON KEY ARRIVAL: (a) ELEVENLABS_API_KEY=<real> node m0-driver.js /tmp/m0.raw "start a thread"
   → expect TRANSCRIPT MATCH + /tmp/m0-out.mp3 (ffprobe it); (b) store key via credentials
   service ref 'ELEVENLABS_API_KEY'; (c) assemble host.js+client.js into ONE cordis_define
   package (plugin idPrefix 'voice', name 'DeepSeek Voice Mode'), cordis_run, approval flow;
   (d) browser-globals probe rides first client activation; (e) PTT smoke per PROTOCOL §6.
3. Post-M1: M2 verbs polish, M3 always-on + settings page, then UI polish pass (impeccable skill).
4. Production promotion path (later): move packages into real repo dir + static cordis.yml row;
   keep dynamic-plugin iteration loop until then.
3. cordis_define orchestrator+client as ONE dynamic plugin (host+client halves), cordis_run,
   approval flow, repair loop per diagnostics.
4. M1 acceptance gate (PROTOCOL §6), then M2 verbs polish, then M3 always-on + settings page.
5. Production promotion path (later): move packages into a real repo dir + static cordis.yml row;
   keep dynamic-plugin iteration loop until then.

## Context-compaction insurance
All durable facts are in the three .md files. If context is compacted: re-read this file +
PLAN/RESEARCH/PROTOCOL, get_goal(), list_agents() to reattach subagents, continue at "Next actions".
