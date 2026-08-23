# Voice client — integration notes

## Component tree
- shell.overlay `dsh-voice-pill` (order 50): collapsed pill (state dot, level bars while
  listening, caption snippet) → expands to panel: threads (title/status/interrupt),
  captions ring, hold-to-talk, power row, unsupported warning.
- sidebar.footer.action `dsh-voice-toggle`: power switch (hard off via config.set enabled).
- conversation.input.left `dsh-voice-ptt`: hold-to-talk bound to current session.

## States
phase mirrors host FSM: disconnected (powered off) / ready / listening / thinking / speaking;
muted flag overlays. Polling: voice.state.get every 4s while mounted + WS-driven updates.
Reconnect: WS close → fresh handshake token → backoff 0.5s→8s.

## Transport
HTTP RPC POST /__dsh-voice/rpc/<method>; WS /__dsh-voice/ws?t=<token>, binary out =
Int16LE 16k mono PCM (~4096-sample chunks from AudioWorklet), JSON text both ways per §1.

## Probes (feature-detected, degrade to pill warning)
navigator.mediaDevices.getUserMedia · WebSocket · AudioContext · Blob/URL (worklet) · fetch

## Deviations
- Playback decodes utterance chunks only at done:true (gapless chain start-time scheduling);
  cancel stops scheduled sources.
- Hotkey matching supports Alt/Ctrl/Shift/Meta + KeyX/DigitX codes; double-press <400ms
  toggles power; hold = PTT. In-page scope (document-level) by design.
