/* deepseek-voice-mode UI — generated client bundle (source: ../client.js). */
window.__ModuleLoader__.load({
  id: "deepseek-voice-mode-ui",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var inject = ["slots", "timer"];

    function apply(ctx) {
      var React = require("react");
              if (!React) { console.error('[dsvm] missing react'); return; }

      /* ============ tiny reactive store ============ */
      var listeners = [];
      function S(init) {
        var v = init;
        return {
          get: function () { return v; },
          set: function (patch) {
            var k;
            for (k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) v[k] = patch[k];
            for (var i = 0; i < listeners.length; i++) { try { listeners[i](v); } catch (e) {} }
          },
        };
      }
      function subscribe(fn) { listeners.push(fn); return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }
      var store = S({
        phase: 'disconnected',   // disconnected|ready|listening|thinking|speaking (+muted flag)
        powered: null,           // null = unknown until first state.get
        muted: false,
        partial: '',
        lastCommitted: '',
        captions: [],
        threads: [],
        speakingText: '',
        level: 0,
        hotkey: '',
        unsupported: '',
        expanded: false,
      });

      /* ============ HTTP RPC transport ============ */
      function rpc(method, args) {
        if (typeof fetch !== 'function') return Promise.resolve({ ok: false, error: { code: 'no_fetch', message: 'fetch unavailable' } });
        return fetch('/__dsh-voice/rpc/' + method, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: args === undefined ? '{}' : JSON.stringify(args),
        }).then(function (r) { return r.json(); }).catch(function (e) {
          return { ok: false, error: { code: 'network', message: String(e && e.message || e) } };
        });
      }

      /* ============ capability probes (lazy, once) ============ */
      var probed = null;
      function probe() {
        if (probed) return probed;
        var problems = [];
        try {
          if (!globalThis.navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) problems.push('microphone');
          if (typeof globalThis.WebSocket !== 'function') problems.push('websocket');
          if (!globalThis.AudioContext && !globalThis.webkitAudioContext) problems.push('audio');
          if (!globalThis.Blob || !globalThis.URL || !URL.createObjectURL) problems.push('worklet');
        } catch (e) { problems.push('probe'); }
        probed = problems;
        if (problems.length) store.set({ unsupported: 'Needs: ' + problems.join(', ') });
        return problems;
      }

      /* ============ WebSocket session (audio leg) ============ */
      var net = { ws: null, backoffMs: 500, closedByUs: false, pingDisposer: null };
      function wsSend(obj) {
        if (net.ws && net.ws.readyState === 1) { try { net.ws.send(JSON.stringify(obj)); } catch (e) {} }
      }
      function connectWs() {
        var problems = probe();
        if (problems.length || typeof WebSocket !== 'function') return;
        if (net.ws && (net.ws.readyState === 0 || net.ws.readyState === 1)) return;
        net.closedByUs = false;
        rpc('voice.handshake').then(function (res) {
          if (!res || !res.ok || !res.token) { scheduleReconnect(); return; }
          var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
          var ws;
          try { ws = new WebSocket(proto + location.host + '/__dsh-voice/ws?t=' + res.token); }
          catch (e) { scheduleReconnect(); return; }
          net.ws = ws;
          ws.onopen = function () {
            net.backoffMs = 500;
            store.set({ phase: 'ready' });
            wsSend({ type: 'ping', ts: Date.now() });
            if (net.pingDisposer) net.pingDisposer();
            net.pingDisposer = ctx.interval(function () { wsSend({ type: 'ping', ts: Date.now() }); }, 10000);
          };
          ws.onmessage = function (ev) {
            var msg = null;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            handleServer(msg);
          };
          ws.onclose = function () {
            if (net.pingDisposer) { net.pingDisposer(); net.pingDisposer = null; }
            net.ws = null;
            stopMic();
            if (!net.closedByUs) scheduleReconnect();
            else refreshState();
          };
          ws.onerror = function () {};
        });
      }
      function disconnectWs() {
        net.closedByUs = true;
        if (net.pingDisposer) { net.pingDisposer(); net.pingDisposer = null; }
        if (net.ws) { try { net.ws.close(1000, 'power off'); } catch (e) {} net.ws = null; }
        stopMic();
      }
      function scheduleReconnect() {
        store.set({ phase: 'disconnected' });
        var delay = net.backoffMs;
        net.backoffMs = Math.min(net.backoffMs * 2, 8000);
        ctx.timeout(function () { refreshState().then(function (st) { if (st && st.helperReady) connectWs(); }); }, delay);
      }
      function handleServer(msg) {
        if (!msg || typeof msg.type !== 'string') return;
        switch (msg.type) {
          case 'ready':
            store.set({ phase: 'ready' });
            break;
          case 'session.state':
            if (msg.state === 'listening') store.set({ phase: 'listening', partial: '' });
            else if (msg.state === 'idle') store.set({ phase: store.get().speakingText ? 'speaking' : 'ready' });
            break;
          case 'stt.partial':
            if (store.get().phase === 'speaking') bargeIn();
            store.set({ partial: typeof msg.text === 'string' ? msg.text : '' });
            break;
          case 'stt.committed':
            store.set({ lastCommitted: msg.text || '', partial: '', phase: 'thinking' });
            break;
          case 'tts.start':
            break;
          case 'tts.audio':
            playChunk(msg.id, msg.b64, msg.done === true);
            break;
          case 'tts.canceled':
            cancelPlayback(msg.id);
            break;
          case 'error':
            console.error('[dsvm]', msg.code, msg.message);
            break;
          default:
            break;
        }
      }
      /* ============ state refresh + power ============ */
      function refreshState() {
        if (typeof fetch !== 'function') return Promise.resolve(null);
        return rpc('voice.state.get').then(function (res) {
          var st = res && res.ok ? res.state : null;
          if (!st) return null;
          store.set({
            powered: st.enabled === true,
            helperReady: !!(st.helper && st.helper.running && st.helper.ready),
            muted: st.muted === true,
            phase: st.phase || 'disconnected',
            speakingText: typeof st.speaking === 'string' ? st.speaking : '',
            captions: Array.isArray(st.captions) ? st.captions : [],
            partial: typeof st.partial === 'string' ? st.partial : store.get().partial,
          });
          return rpc('voice.config.get').then(function (cres) {
            if (cres && cres.ok && cres.config) store.set({ hotkey: cres.config.hotkey || '' });
            return store.get();
          });
        }).catch(function () { return null; });
      }
      function powerOn() {
        return rpc('voice.config.set', { patch: { enabled: true } }).then(function () {
          return refreshState();
        }).then(function () { connectWs(); refreshThreads(); });
      }
      function powerOff() {
        return rpc('voice.config.set', { patch: { enabled: false } }).then(function () {
          disconnectWs();
          store.set({ phase: 'disconnected', threads: [] });
        });
      }
      function refreshThreads() {
        return rpc('voice.threads.list').then(function (res) {
          if (res && res.ok && Array.isArray(res.threads)) store.set({ threads: res.threads });
        });
      }

      /* ============ mic capture ============ */
      var mic = { stream: null, ctxA: null, node: null, workletLoaded: false, lastLevelTs: 0 };
      var WORKLET_SRC =
        'class DsvmTap extends AudioWorkletProcessor {' +
        ' constructor(){super();this.buf=new Float32Array(4096);this.n=0;}' +
        ' process(inputs){var ch=inputs[0]&&inputs[0][0];if(!ch)return true;' +
        ' for(var i=0;i<ch.length;i++){this.buf[this.n++]=ch[i];if(this.n>=4096){this.port.postMessage(this.buf.slice(0,this.n));this.n=0;}}' +
        ' return true;}}' +
        'registerProcessor("dsvm-tap",DsvmTap);';
      function floatToInt16(f32) {
        var out = new Int16Array(f32.length);
        for (var i = 0; i < f32.length; i++) {
          var s = Math.max(-1, Math.min(1, f32[i]));
          out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
      }
      function startMic() {
        var problems = probe();
        if (problems.length) return Promise.resolve(false);
        if (mic.stream) return Promise.resolve(true);
        return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
          .then(function (stream) {
            var AC = globalThis.AudioContext || globalThis.webkitAudioContext;
            var ctxA;
            try { ctxA = new AC({ sampleRate: 16000 }); } catch (e) { ctxA = new AC(); }
            mic.stream = stream;
            mic.ctxA = ctxA;
            var src = ctxA.createMediaStreamSource(stream);
            return ctxA.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' })))
              .then(function () {
                var node = new AudioWorkletNode(ctxA, 'dsvm-tap');
                node.port.onmessage = function (ev) {
                  var f32 = ev.data;
                  // RMS level (throttled ~10/s)
                  var now = Date.now();
                  if (now - mic.lastLevelTs > 100) {
                    mic.lastLevelTs = now;
                    var sum = 0;
                    for (var i = 0; i < f32.length; i += 8) sum += f32[i] * f32[i];
                    store.set({ level: Math.min(1, Math.sqrt(sum / (f32.length / 8)) * 4) });
                  }
                  if (!(net.ws && net.ws.readyState === 1)) return;
                  var targetRate = 16000;
                  var pcm = f32;
                  if (ctxA.sampleRate !== targetRate) {
                    // linear resample
                    var ratio = ctxA.sampleRate / targetRate;
                    var n = Math.floor(f32.length / ratio);
                    pcm = new Float32Array(n);
                    for (var j = 0; j < n; j++) pcm[j] = f32[Math.floor(j * ratio)];
                  }
                  try { net.ws.send(floatToInt16(pcm).buffer); } catch (e) {}
                };
                src.connect(node);
                node.connect(ctxA.destination); // keep graph live; volume managed via gain 0
                try { node.disconnect(); } catch (e2) {} // silent tap: no monitoring needed
                mic.node = node;
                return true;
              });
          }).catch(function (err) {
            console.error('[dsvm] mic failed:', err && err.message);
            stopMic();
            return false;
          });
      }
      function stopMic() {
        if (mic.node) { try { mic.node.port.onmessage = null; mic.node.disconnect(); } catch (e) {} mic.node = null; }
        if (mic.ctxA) { try { mic.ctxA.close(); } catch (e) {} mic.ctxA = null; }
        if (mic.stream) { mic.stream.getTracks().forEach(function (t) { t.stop(); }); mic.stream = null; }
        store.set({ level: 0 });
      }
      function pttDown() {
        if (store.get().phase === 'disconnected') return;
        startMic().then(function (ok) { if (ok) wsSend({ type: 'listen.start', commit: 'vad' }); });
      }
      function pttUp() {
        if (store.get().phase === 'disconnected') return;
        wsSend({ type: 'listen.stop' });
        stopMic();
      }

      /* ============ playback engine ============ */
      var play = { ctxP: null, utts: {} }; // id -> {chunks:[], sources:[], nextAt}
      function ensurePlayCtx() {
        if (!play.ctxP) {
          var AC = globalThis.AudioContext || globalThis.webkitAudioContext;
          play.ctxP = new AC();
        }
        if (play.ctxP.state === 'suspended') { try { play.ctxP.resume(); } catch (e) {} }
        return play.ctxP;
      }
      function b64ToBytes(b64) {
        var bin = atob(b64);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      function bargeIn() {
        // user started talking while we speak: cancel TTS + drop queued audio
        wsSend({ type: 'tts.cancel' });
        Object.keys(play.utts).forEach(function (id) { cancelPlayback(id); });
      }
      function cancelPlayback(id) {
        var u = play.utts[id];
        if (!u) return;
        u.sources.forEach(function (s) { try { s.stop(); } catch (e) {} });
        delete play.utts[id];
      }
      function playChunk(id, b64, done) {
        if (!b64) { if (done) cancelPlayback(id); return; }
        var u = play.utts[id];
        if (!u) u = play.utts[id] = { chunks: [], sources: [], nextAt: 0 };
        u.chunks.push(b64);
        if (!done) return;
        // utterance complete: decode all chunks then play gaplessly
        var ctxP = ensurePlayCtx();
        var buffers = [];
        var chain = Promise.resolve();
        u.chunks.forEach(function (b) {
          chain = chain.then(function () {
            return ctxP.decodeAudioData(b64ToBytes(b).buffer.slice(0));
          }).then(function (buf) { buffers.push(buf); }).catch(function (e) {});
        });
        chain.then(function () {
          delete play.utts[id];
          var at = Math.max(ctxP.currentTime + 0.02, u.nextAt || 0);
          buffers.forEach(function (buf) {
            var src = ctxP.createBufferSource();
            src.buffer = buf;
            src.connect(ctxP.destination);
            src.start(at);
            u.sources.push(src);
            at += buf.duration;
          });
          u.nextAt = at;
          if (buffers.length === 0) store.set({ phase: 'ready', speakingText: '' });
        });
      }
      /* ============ React components ============ */
      function useStore() {
        var snap = React.useState(store.get())[0];
        React.useEffect(function () { return subscribe(function () { snap.n = (snap.n || 0) + 1; }); }, []);
        var force = React.useState(0)[1];
        React.useEffect(function () { return subscribe(function () { force(function (n) { return n + 1; }); }); }, []);
        return store.get();
      }
      var PHASE_COLOR = {
        disconnected: 'var(--dsvm-off, #555)',
        ready: 'var(--dsvm-ready, #8a8f98)',
        listening: 'var(--dsvm-listen, #34c759)',
        thinking: 'var(--dsvm-think, #f5a623)',
        speaking: 'var(--dsvm-speak, #3b82f6)',
      };
      function el(type, props) { var kids = Array.prototype.slice.call(arguments, 2); return React.createElement.apply(React, [type, props || null].concat(kids)); }

      function LevelBars(props) {
        var s = props.s;
        if (s.phase !== 'listening') return null;
        var bars = [];
        for (var i = 0; i < 4; i++) {
          var h = 3 + Math.round(Math.min(1, Math.max(0, s.level * 4 - i)) * 9);
          bars.push(el('span', { key: i, className: 'dsvm-bar', style: { height: h + 'px' } }));
        }
        return el('span', { className: 'dsvm-bars' }, bars);
      }

      function Pill(props) {
        var s = useStore();
        var dot = el('span', { className: 'dsvm-dot ' + (s.phase === 'listening' ? 'dsvm-pulse' : ''), style: { background: PHASE_COLOR[s.phase] || '#888' } });
        var snippet = s.partial || s.lastCommitted || (s.phase === 'disconnected' ? 'Voice is off' : s.phase);
        var inner = [
          dot,
          s.phase === 'listening' ? el(LevelBars, { key: 'bars', s: s }) : null,
          el('span', { key: 'txt', className: 'dsvm-snippet' }, snippet),
        ];
        if (!s.expanded) {
          return el('div', { className: 'dsvm-pill', onClick: function () { store.set({ expanded: true }); refreshThreads(); } }, inner);
        }
        var threadCards = s.threads.slice(0, 8).map(function (t) {
          return el('div', { key: t.id, className: 'dsvm-thread' },
            el('span', { className: 'dsvm-thread-title' }, t.title || t.id),
            el('span', { className: 'dsvm-chip dsvm-chip-' + t.status }, String(t.status || '?')),
            el('button', {
              className: 'dsvm-btn',
              title: 'Interrupt this thread',
              onClick: function () { rpc('voice.thread.interrupt', { id: t.id }); },
            }, '■'));
        });
        var captions = s.captions.slice(-30).map(function (c, i) {
          return el('div', { key: i, className: 'dsvm-cap dsvm-cap-' + c.level }, String(c.text || ''));
        });
        return el('div', { className: 'dsvm-panel' },
          el('div', { className: 'dsvm-panel-head' },
            el('strong', null, 'Voice'),
            el('button', { className: 'dsvm-btn', onClick: function () { store.set({ expanded: false }); } }, '×')),
          el('div', { className: 'dsvm-threads' }, threadCards.length ? threadCards : el('div', { className: 'dsvm-empty' }, 'No threads yet')),
          el('div', { className: 'dsvm-caps' }, captions),
          el('div', { className: 'dsvm-row' },
            el('button', {
              className: 'dsvm-btn dsvm-ptt' + (s.phase === 'disconnected' ? ' dsvm-disabled' : ''),
              disabled: s.phase === 'disconnected',
              title: s.phase === 'disconnected' ? 'Voice is off' : 'Hold to talk',
              onPointerDown: function () { pttDown(); },
              onPointerUp: function () { pttUp(); },
              onPointerLeave: function () { if (s.phase === 'listening') pttUp(); },
            }, '🎙 Hold to talk'),
            el('button', {
              className: 'dsvm-btn',
              onClick: function () { (s.powered ? powerOff() : powerOn()); },
            }, s.powered ? 'Power off' : 'Power on')),
          s.unsupported ? el('div', { className: 'dsvm-warn' }, s.unsupported) : null);
      }

      function Toggle(props) {
        var s = useStore();
        var off = s.phase === 'disconnected';
        return el('button', {
          className: 'dsvm-toggle' + (off ? ' dsvm-off' : ''),
          title: off ? 'Turn voice on' : 'Turn voice off',
          onClick: function () { (s.powered ? powerOff() : powerOn()); },
        }, off ? '🔇' : '🎙');
      }

      function PttButton(props) {
        var s = useStore();
        var off = s.phase === 'disconnected';
        return el('button', {
          className: 'dsvm-input-ptt' + (off ? ' dsvm-disabled' : '') + (s.phase === 'listening' ? ' dsvm-live' : ''),
          title: off ? 'Voice is off' : 'Hold to talk',
          disabled: false,
          onPointerDown: function (e) { e.preventDefault(); if (!off) pttDown(); },
          onPointerUp: function () { if (!off) pttUp(); },
          onPointerLeave: function () { if (!off && s.phase === 'listening') pttUp(); },
        }, '🎙');
      }

      /* ============ hotkey ============ */
      var hk = { listeners: null, lastTap: 0 };
      function parseCombo(combo, e) {
        // 'Alt+Shift+V' style — match modifiers + e.code
        var parts = String(combo || '').split('+').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
        if (!parts.length) return false;
        var needAlt = parts.indexOf('alt') >= 0, needCtrl = parts.indexOf('ctrl') >= 0 || parts.indexOf('control') >= 0;
        var needShift = parts.indexOf('shift') >= 0, needMeta = parts.indexOf('meta') >= 0 || parts.indexOf('cmd') >= 0;
        var codePart = parts.filter(function (p) { return ['alt', 'ctrl', 'control', 'shift', 'meta', 'cmd'].indexOf(p) < 0; })[0];
        if (!codePart) return false;
        var code = 'Key' + codePart.toUpperCase();
        if (code.length <= 4 && /^[0-9]$/.test(codePart)) code = 'Digit' + codePart;
        return e.altKey === needAlt && e.ctrlKey === needCtrl && e.shiftKey === needShift && e.metaKey === needMeta && e.code === code;
      }
      function installHotkey() {
        var combo = store.get().hotkey;
        if (!combo || !document || typeof document.addEventListener !== 'function') return;
        uninstallHotkey();
        var down = function (e) {
          if (!parseCombo(combo, e)) return;
          e.preventDefault();
          if (e.repeat) return;
          var now = Date.now();
          if (now - hk.lastTap < 400) { hk.lastTap = 0; (store.get().powered ? powerOff() : powerOn()); return; }
          hk.lastTap = now;
          pttDown();
        };
        var up = function (e) {
          if (!parseCombo(combo, e)) return;
          e.preventDefault();
          pttUp();
        };
        document.addEventListener('keydown', down);
        document.addEventListener('keyup', up);
        hk.listeners = { down: down, up: up };
      }
      function uninstallHotkey() {
        if (hk.listeners && document) {
          document.removeEventListener('keydown', hk.listeners.down);
          document.removeEventListener('keyup', hk.listeners.up);
        }
        hk.listeners = null;
      }

      /* ============ styles ============ */
      function dsvmInsertCss(cssText) {
        if (typeof document === 'undefined') return;
        if (document.querySelector('style[data-dsvm]')) return;
        var tag = document.createElement('style');
        tag.setAttribute('data-dsvm', '1');
        tag.textContent = cssText;
        document.head.appendChild(tag);
      }
      dsvmInsertCss([
        '.dsvm-pill,.dsvm-panel,.dsvm-toggle,.dsvm-input-ptt{font:inherit;box-sizing:border-box;}',
        '.dsvm-pill{position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;align-items:center;gap:8px;',
        ' padding:6px 12px;border-radius:999px;background:var(--dsvm-bg,#1f2127);color:var(--dsvm-fg,#e8eaed);',
        ' box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer;max-width:340px;user-select:none;}',
        '.dsvm-dot{width:10px;height:10px;border-radius:50%;flex:none;display:inline-block;}',
        '.dsvm-pulse{animation:dsvmPulse 1.1s ease-in-out infinite;}',
        '@keyframes dsvmPulse{0%,100%{opacity:1}50%{opacity:.35}}',
        '@media (prefers-reduced-motion: reduce){.dsvm-pulse{animation:none}}',
        '.dsvm-bars{display:inline-flex;align-items:flex-end;gap:2px;height:12px;}',
        '.dsvm-bar{width:3px;background:currentColor;border-radius:1px;display:inline-block;}',
        '.dsvm-snippet{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;opacity:.9;}',
        '.dsvm-panel{position:fixed;right:16px;bottom:56px;z-index:10000;width:320px;max-height:60vh;overflow:auto;',
        ' background:var(--dsvm-bg,#1f2127);color:var(--dsvm-fg,#e8eaed);border-radius:12px;padding:12px;',
        ' box-shadow:0 8px 28px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:8px;font-size:13px;}',
        '.dsvm-panel-head{display:flex;justify-content:space-between;align-items:center;}',
        '.dsvm-thread{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(128,128,128,.15);}',
        '.dsvm-thread-title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.dsvm-chip{font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(128,128,128,.25);text-transform:uppercase;}',
        '.dsvm-btn{background:rgba(128,128,128,.18);color:inherit;border:0;border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12px;}',
        '.dsvm-btn:hover{background:rgba(128,128,128,.32);}',
        '.dsvm-disabled{opacity:.45;cursor:not-allowed!important;}',
        '.dsvm-empty{opacity:.6;padding:6px 0;}',
        '.dsvm-caps{max-height:140px;overflow:auto;display:flex;flex-direction:column;gap:2px;}',
        '.dsvm-cap{font-size:12px;opacity:.85;} .dsvm-cap-error{color:#ff6b6b;opacity:1;}',
        '.dsvm-row{display:flex;gap:8px;justify-content:space-between;}',
        '.dsvm-ptt{flex:1;text-align:center;}',
        '.dsvm-warn{color:#ffb020;font-size:11px;}',
        '.dsvm-toggle{border:0;background:transparent;color:inherit;font-size:15px;cursor:pointer;padding:2px 6px;border-radius:6px;}',
        '.dsvm-toggle:hover{background:rgba(128,128,128,.2);}',
        '.dsvm-toggle.dsvm-off{opacity:.45;}',
        '.dsvm-input-ptt{border:0;background:transparent;color:inherit;font-size:14px;cursor:pointer;padding:2px 6px;border-radius:6px;}',
        '.dsvm-input-ptt:hover{background:rgba(128,128,128,.2);}',
        '.dsvm-input-ptt.dsvm-live{background:rgba(52,199,117,.25);}',

  ].join('\n'));

      /* ============ slot registration + wiring ============ */
      var slots = ctx.slots;
      if (!slots) { console.error('[dsvm] slots service absent'); return; }
      slots.inject('shell.overlay', function () {
        return slots.register({ name: 'shell.overlay', id: 'dsh-voice-pill', order: 50 }, function () { return el(Pill); });
      });
      slots.inject('sidebar.footer.action', function () {
        return slots.register({ name: 'sidebar.footer.action', id: 'dsh-voice-toggle' }, function () { return el(Toggle); });
      });
      slots.inject('conversation.input.left', function () {
        return slots.register({ name: 'conversation.input.left', id: 'dsh-voice-ptt' }, function () { return el(PttButton); });
      });

      ctx.effect(function () {
        refreshState().then(function (st) {
          installHotkey();
          if (st && st.powered && st.helperReady) connectWs();
        });
        var poll = ctx.interval(function () {
          refreshState();
        }, 4000);
        return function () {
          poll();
          uninstallHotkey();
          disconnectWs();
          stopMic();
          Object.keys(play.utts).forEach(function (id) { cancelPlayback(id); });
          if (play.ctxP) { try { play.ctxP.close(); } catch (e) {} play.ctxP = null; }
        };
      });

      console.log('[dsvm] client half activated');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
