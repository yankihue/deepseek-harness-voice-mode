'use strict';

/**
 * bridge.js — browser-leg WebSocket session management (PROTOCOL.md §1, §3).
 *
 * Responsibilities:
 *   - one BrowserSession per socket.attach (connId); v1: one conn at a time
 *   - RFC6455 server handshake over piped raw bytes (wsio.parseHandshake)
 *   - hello token validation (token from the attach URL query, echoed by the
 *     browser in {type:'hello', token, proto:1}) — belt and braces on top of
 *     the host's URL check; no session starts without a valid hello
 *   - ping/pong echo + heartbeat: peers silent for >30 s are closed
 *   - routing: binary frames → STT audio; JSON frames → listen/tts/ping/handlers
 *   - STT (SttSession) per listen session, TTS (TtsUtterance) per tts.speak
 *   - cleanup of every socket, timer and session on close / detach / stop
 *
 * Outbound surfaces (set by entry.js):
 *   bridge.onControl(obj)          → tunnel JSON line (socket.open/close/log/error)
 *   bridge.onSocketBytes(connId, b)→ tunnel byte record (WS frame bytes)
 *
 * Zero npm dependencies.
 */

const { parseHandshake, buildUpgradeResponse, buildHttpErrorResponse } = require('./wsio.js');
const {
  FrameDecoder,
  encodeClose,
  encodePong,
  OP,
  decodeClosePayload,
  WsProtocolError,
} = require('./wsio.js');
const { SttSession } = require('./stt.js');
const { TtsUtterance } = require('./tts.js');

const HEARTBEAT_CHECK_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 30000;
const VALID_PATH = '/__dsh-voice/ws';

// W2 (orchestrator) convention, INTEGRATION.md §4.1: the v1 single connection
// "c1" rides connIdx 1 on the byte tunnel. Outbound records use the connIdx
// observed on the first inbound record (adoption), defaulting to 1.
const DEFAULT_CONN_IDX = 1;

/** Extract the one-time token from an attach URL's query string. */
function parseTokenFromQuery(query) {
  if (!query) return undefined;
  try {
    return new URLSearchParams(query).get('t') || undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * One attached browser connection.
 *
 * @param {object} deps
 * @param {string} deps.connId
 * @param {string} deps.url              attach URL (path + ?t=<token>)
 * @param {string} deps.apiKey           ELEVENLABS_API_KEY (may be empty)
 * @param {object} deps.voiceConfig      voiceId/ttsModel/sttModel/...
 * @param {Function} deps.connectStt      (url, {headers}) => WebSocketLike
 * @param {Function} deps.connectTts      (url) => WebSocketLike
 * @param {Function} deps.log             (level, msg)
 * @param {Function} deps.emitControl     (obj) — socket.open/close/log/error
 * @param {Function} deps.emitBytes       (Buffer) — WS frame bytes back down the socket
 * @param {Function} deps.onClosed        (code, reason) — firewall to Bridge
 */
class BrowserSession {
  constructor(deps) {
    this.connId = deps.connId;
    this.url = deps.url;
    this.apiKey = deps.apiKey;
    this.cfg = deps.voiceConfig || {};
    this.connectStt = deps.connectStt;
    this.connectTts = deps.connectTts;
    this.log = deps.log || (() => {});
    this.emitControl = deps.emitControl;
    this.emitBytes = deps.emitBytes;
    this.onClosed = deps.onClosed;

    const u = new URL(this.url, 'http://localhost');
    this.path = u.pathname;
    this.attachToken = parseTokenFromQuery(u.search.slice(1));

    this.closed = false;
    this.handshakeDone = false;
    this.opened = false; // socket.open already emitted (101 accepted)
    this.helloOk = false;
    this.listening = false;
    this.lastSeen = Date.now();
    this.hbCheckMs = deps.hbCheckMs || HEARTBEAT_CHECK_MS;
    this.hbTimeoutMs = deps.hbTimeoutMs || HEARTBEAT_TIMEOUT_MS;

    this.pendingHandshake = Buffer.alloc(0);
    this.decoder = new FrameDecoder({ requireMask: true });
    this.hbInterval = null;
    this.stt = null;
    this.ttsActive = new Map(); // id → TtsUtterance (insertion order = start order)
    this._currentState = null; // null ⇒ first observed state is always emitted
  }

  // ------------------------------------------------------------------ bytes

  /** Raw socket bytes from the host (handshake first, then WS frames). */
  feedBytes(chunk) {
    if (this.closed) return;
    this.lastSeen = Date.now();

    if (!this.handshakeDone) {
      this.pendingHandshake =
        this.pendingHandshake.length === 0
          ? Buffer.from(chunk)
          : Buffer.concat([this.pendingHandshake, chunk]);
      const parsed = parseHandshake(this.pendingHandshake);
      if (parsed === null) return; // header not complete yet
      const hl = this.pendingHandshake.indexOf('\r\n\r\n') + 4;
      const head = this.pendingHandshake.subarray(hl);
      this.pendingHandshake = Buffer.alloc(0);
      if (parsed.error) {
        this._rejectHandshake(parsed.error);
        return;
      }
      if (this.path !== VALID_PATH) {
        this._rejectHandshake(`wrong path '${this.path}' (expected ${VALID_PATH})`);
        return;
      }
      this.handshakeDone = true;
      try {
        this.emitBytes(buildUpgradeResponse(parsed.key));
      } catch (_) {
        /* write side already dead */
      }
      this.opened = true;
      this.emitControl({ type: 'socket.open', connId: this.connId });
      this._startHeartbeat();
      this.log('debug', `conn ${this.connId}: handshake accepted`);
      this.feedBytes(head); // process any bytes that arrived with the headers
      return;
    }

    let frames;
    try {
      frames = this.decoder.feed(chunk);
    } catch (err) {
      this._protocolViolation(err);
      return;
    }
    for (const frame of frames) this._onFrame(frame);
  }

  _rejectHandshake(reason) {
    this.closed = true;
    this.log('warn', `conn ${this.connId}: handshake rejected: ${reason}`);
    try {
      this.emitBytes(buildHttpErrorResponse(400, reason));
    } catch (_) {
      /* ignore */
    }
    this.onClosed(1006, `handshake rejected: ${reason}`);
  }

  // ----------------------------------------------------------------- frames

  _onFrame(frame) {
    if (this.closed) return;
    switch (frame.opcode) {
      case OP.TEXT: {
        let obj;
        try {
          obj = JSON.parse(frame.payload.toString('utf8'));
        } catch (err) {
          this._protocolViolation(new WsProtocolError(`bad JSON text frame: ${err.message}`));
          return;
        }
        this._onControlMessage(obj, 'browser');
        break;
      }
      case OP.BINARY: {
        if (!this.helloOk) {
          this.log('debug', 'dropping pre-hello binary audio');
          return;
        }
        if (!this.listening || !this.stt) {
          this.log('debug', 'dropping audio while not listening');
          return;
        }
        this.stt.feedAudio(frame.payload);
        break;
      }
      case OP.PING:
        try {
          this.emitBytes(encodePong(frame.payload));
        } catch (_) {
          /* ignore */
        }
        break;
      case OP.PONG:
        break;
      case OP.CLOSE: {
        let code = 1000;
        let reason = '';
        try {
          ({ code, reason } = decodeClosePayload(frame.payload));
        } catch (err) {
          code = 1002;
          reason = err.message;
        }
        this.log('debug', `conn ${this.connId}: peer closed (${code}: ${reason})`);
        this._shutdown(code, reason);
        break;
      }
      default:
        break;
    }
  }

  _protocolViolation(err) {
    this.log('warn', `conn ${this.connId}: WS protocol error: ${err.message}`);
    this.sendText({ type: 'error', code: 'proto', message: err.message, fatal: true });
    this._shutdown(1002, err.message);
  }

  // ------------------------------------------------------------ control text

  /**
   * Host-injected browser-style control frame (INTEGRATION.md §4.5): the
   * orchestrator sends listen.start/stop, tts.speak, tts.cancel as tunnel
   * records whose payload is bare JSON. The host is a trusted caller (it
   * already validated the one-time token pre-attach), so these bypass the
   * browser hello gate — otherwise a queue pump with no browser peer could
   * never advance (host V2/§C.2).
   */
  injectJson(text) {
    if (this.closed) return;
    this.lastSeen = Date.now();
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (err) {
      this.log('warn', `conn ${this.connId}: malformed host-injected JSON: ${err.message}`);
      return;
    }
    this._onControlMessage(obj, 'host');
  }

  _onControlMessage(obj, source) {
    if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') {
      this._protocolViolation(new WsProtocolError('malformed control message'));
      return;
    }
    if (!this.helloOk && source !== 'host') {
      if (obj.type !== 'hello') {
        this.log('debug', `dropping '${obj.type}' before hello`);
        return;
      }
      this._handleHello(obj);
      return;
    }
    switch (obj.type) {
      case 'hello':
        if (!this.helloOk) {
          this._handleHello(obj);
          break;
        }
        // Re-hello = reconnect per PROTOCOL §1 ("Reconnect = new hello").
        // The host tears down + re-attaches on reconnect, so a live-socket
        // re-hello is out of spec: refuse rather than gamble.
        this.log('warn', `conn ${this.connId}: unexpected re-hello`);
        this.sendText({ type: 'error', code: 'auth', message: 'unexpected re-hello', fatal: true });
        this._shutdown(1008, 'unexpected re-hello');
        break;
      case 'listen.start':
        this._handleListenStart(obj);
        break;
      case 'listen.stop':
        this._handleListenStop();
        break;
      case 'tts.speak':
        this._handleTtsSpeak(obj);
        break;
      case 'tts.cancel':
        this._handleTtsCancel(obj);
        break;
      case 'ping':
        if (typeof obj.ts === 'number') this.sendText({ type: 'pong', ts: obj.ts });
        break;
      default:
        this.log('debug', `unknown control type '${obj.type}' ignored`);
    }
  }

  _handleHello(obj) {
    const protoOk = obj.proto === 1;
    const tokOk = typeof obj.token === 'string' && this.attachToken !== undefined && obj.token === this.attachToken;
    if (!protoOk || !tokOk) {
      this.log('warn', `conn ${this.connId}: hello rejected (proto=${obj.proto}, token match=${tokOk})`);
      this.sendText({ type: 'error', code: 'auth', message: 'invalid hello (token/proto)', fatal: true });
      this._shutdown(1008, 'invalid hello');
      return;
    }
    this.helloOk = true;
    this.log('info', `conn ${this.connId}: hello accepted`);
    this.sendText({ type: 'ready', proto: 1 });
    this._setState('idle');
  }

  _handleListenStart(obj) {
    if (this.stt && !this.stt.stopped) {
      this.log('debug', 'listen.start while already listening: restarting STT');
      this.stt.abort();
      this.stt = null;
    }
    const commitStrategy = obj.commit === 'manual' ? 'manual' : 'vad';
    this.listening = true;
    this.stt = new SttSession({
      apiKey: this.apiKey,
      connect: this.connectStt,
      handlers: {
        onStarted: () => {
          this._setState('listening');
        },
        onPartial: (text) => this.sendText({ type: 'stt.partial', text }),
        onCommitted: (text) => this.sendText({ type: 'stt.committed', text }),
        onError: (code, message) => {
          this.listening = false;
          this.sendText({ type: 'stt.error', code, message });
          this._setState('idle');
        },
        onStopped: () => {
          this.listening = false;
          this._setState('idle');
        },
        log: (level, msg) => this.log(level, `[stt] ${msg}`),
      },
      opts: {
        commitStrategy,
        languageCode: typeof obj.language === 'string' ? obj.language : undefined,
        modelId: this.cfg.sttModel,
        audioFormat: this.cfg.sttAudioFormat,
        sampleRate: this.cfg.sttSampleRate,
      },
    });
    this.stt.start();
  }

  _handleListenStop() {
    if (this.stt) {
      const s = this.stt;
      this.stt = null;
      this.listening = false;
      s.stop(); // flush + commit, then close
    } else {
      this.listening = false;
    }
    this._setState('idle');
  }

  _handleTtsSpeak(obj) {
    if (typeof obj.id !== 'string' || !obj.id || typeof obj.text !== 'string') {
      this.log('warn', `conn ${this.connId}: malformed tts.speak`);
      return;
    }
    if (this.ttsActive.has(obj.id)) {
      this.log('debug', `tts.speak for active id '${obj.id}': canceling old first`);
      this.ttsActive.get(obj.id).cancel();
    }
    const utter = new TtsUtterance({
      id: obj.id,
      apiKey: this.apiKey,
      text: obj.text,
      connect: this.connectTts,
      handlers: {
        onStart: () => {
          this.sendText({ type: 'tts.start', id: obj.id });
          this._setState('speaking');
        },
        onAudio: (b64, done) => {
          this.sendText({ type: 'tts.audio', id: obj.id, b64, done: !!done });
          if (done) {
            this.ttsActive.delete(obj.id);
            this._setState('idle');
          }
        },
        onCanceled: () => {
          this.ttsActive.delete(obj.id);
          this.sendText({ type: 'tts.canceled', id: obj.id });
          this._setState('idle');
        },
        onError: (code, message) => {
          this.ttsActive.delete(obj.id);
          // Host FSM/queue trigger (INTEGRATION.md §4.6): TTS failures emit
          // type 'tts.error' carrying the utterance id — one of the three
          // exact-once terminals (tts.audio{done:true} | tts.canceled | tts.error).
          this.sendText({ type: 'tts.error', id: obj.id, code, message });
          this._setState('idle');
        },
        log: (level, msg) => this.log(level, `[tts:${obj.id}] ${msg}`),
      },
      opts: {
        voiceId: this.cfg.voiceId,
        modelId: this.cfg.ttsModel,
        voiceSettings: this.cfg.voiceSettings,
        maxChars: this.cfg.ttsMaxChars,
      },
    });
    this.ttsActive.set(obj.id, utter);
    utter.speak();
  }

  _handleTtsCancel(obj) {
    if (typeof obj.id === 'string' && obj.id) {
      const u = this.ttsActive.get(obj.id);
      if (u) u.cancel();
      return;
    }
    // Omit id = cancel the current (most recently started active) utterance.
    const current = this._currentTts();
    if (current) current.cancel();
  }

  _currentTts() {
    let last = null;
    for (const u of this.ttsActive.values()) last = u; // Map preserves insertion order
    return last;
  }

  _setState(state) {
    if (state === this._currentState) return;
    this._currentState = state;
    this.sendText({ type: 'session.state', state });
  }

  // ------------------------------------------------------------- heartbeat

  _startHeartbeat() {
    if (this.hbInterval) return;
    this.hbInterval = setInterval(() => {
      if (this.closed) return;
      const silent = Date.now() - this.lastSeen;
      if (silent > this.hbTimeoutMs) {
        this.log('warn', `conn ${this.connId}: heartbeat timeout (${silent}ms silence)`);
        this._shutdown(1000, 'heartbeat timeout');
      }
    }, this.hbCheckMs);
    // The helper's stdin/socket lifecycle owns process liveness. A forgotten
    // browser detach must not keep shutdown or the offline test runner alive.
    if (typeof this.hbInterval.unref === 'function') this.hbInterval.unref();
  }

  // -------------------------------------------------------------- teardown

  /** CLOSE-frame path / heartbeat / protocol violation: teardown + notify host. */
  _shutdown(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this._teardownSessions();
    if (this.hbInterval) {
      clearInterval(this.hbInterval);
      this.hbInterval = null;
    }
    if (this.handshakeDone) {
      try {
        this.emitBytes(encodeClose(code, typeof reason === 'string' ? reason : ''));
      } catch (_) {
        /* ignore */
      }
    }
    this.onClosed(code, reason);
  }

  /** Host told us the socket is gone (socket.detach). */
  detach() {
    if (this.closed) return;
    this.closed = true;
    this._teardownSessions();
    if (this.hbInterval) {
      clearInterval(this.hbInterval);
      this.hbInterval = null;
    }
    this.onClosed(1006, 'detached');
  }

  /** Global stop: silent teardown, no frames, no control chatter. */
  stop() {
    if (this.closed) return;
    this.closed = true;
    this._teardownSessions({ silent: true });
    if (this.hbInterval) {
      clearInterval(this.hbInterval);
      this.hbInterval = null;
    }
  }

  _teardownSessions() {
    if (this.stt) {
      const s = this.stt;
      this.stt = null;
      this.listening = false;
      s.abort();
    }
    for (const u of this.ttsActive.values()) u.abort();
    this.ttsActive.clear();
  }

  /**
   * Emit a browser-bound WS text message. Per INTEGRATION.md §4.5/§4.3 the
   * payload rides the tunnel as BARE JSON text (first byte '{'); the host
   * wraps it into a WS text frame for the browser (relayBytes heuristic) and
   * peeks it for stt.* / tts.* / session.state to drive its FSM. Raw control
   * frames (close/pong echo, the 101 response) are emitted separately as
   * complete WS frame bytes via emitBytes and relayed verbatim.
   */
  sendText(obj) {
    if (this.closed) return;
    try {
      this.emitBytes(Buffer.from(JSON.stringify(obj), 'utf8'));
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * ConnId registry + demultiplexer for the host ⇄ helper byte tunnel.
 *
 * W2 convention (INTEGRATION.md §4.1): the v1 connection c1 rides connIdx 1.
 * The helper adopts whatever connIdx the host uses on the first inbound
 * record for its single connection (defaulting to 1) and echoes it on every
 * outbound record — the host drops records whose connIdx does not match the
 * conn it attached (host.js handleTunnelRecord).
 *
 * Record dispatch (INTEGRATION.md §4.5): payloads whose first byte is '{'
 * are host-injected browser-style control frames (bare JSON, no WS framing)
 * and are parsed directly; everything else is raw socket bytes (HTTP upgrade
 * request first, then masked browser WS frames).
 *
 * Usage (entry.js):
 *   bridge.onControl = (obj) => writer.json(obj);
 *   bridge.onSocketBytes = (connId, bytes) => writer.record(bridge.connIndex(connId), bytes);
 *   ... feedRecord(connIdx, payload) / detach / stop
 */
class Bridge {
  constructor({ apiKey, voiceConfig = {}, connectStt, connectTts, log = () => {} }) {
    this.apiKey = apiKey;
    this.voiceConfig = voiceConfig;
    this.connectStt = connectStt;
    this.connectTts = connectTts;
    this.log = log;
    this.conns = new Map(); // connId → BrowserSession
    this.connOrder = []; // connId insertion order
    this.connByIdx = new Map(); // adopted connIdx → connId (v1: {1 → 'c1'})
    this.onControl = null; // (obj) => void
    this.onSocketBytes = null; // (connId, bytes) => void
  }

  /** connIdx to use for outbound records for connId (adopted, else 1). */
  connIndex(connId) {
    const sess = this.conns.get(connId);
    if (!sess) return -1;
    return sess.connIdx !== undefined ? sess.connIdx : DEFAULT_CONN_IDX;
  }

  _forgetConn(connId) {
    this.conns.delete(connId);
    const i = this.connOrder.indexOf(connId);
    if (i !== -1) this.connOrder.splice(i, 1);
    for (const [idx, id] of this.connByIdx) {
      if (id === connId) this.connByIdx.delete(idx);
    }
  }

  _control(obj) {
    try {
      this.onControl?.(obj);
    } catch (_) {
      /* ignore */
    }
  }

  _dispatch(connId, payload) {
    const sess = this.conns.get(connId);
    if (!sess) {
      this.log('warn', `bytes for unattached conn '${connId}' dropped`);
      return;
    }
    if (payload.length > 0 && payload[0] === 0x7b /* '{' */) {
      sess.injectJson(payload.toString('utf8'));
    } else {
      sess.feedBytes(payload);
    }
  }

  attach(connId, url) {
    if (this.conns.has(connId)) {
      this.log('warn', `attach for already-attached conn '${connId}'`);
      return true;
    }
    if (this.conns.size >= 1) {
      // v1: one conn at a time (multi-tab is M3).
      this.log('warn', `refusing second conn '${connId}' while '${this.connOrder[0]}' is attached`);
      this._control({ type: 'error', code: 'busy', connId, message: 'one connection at a time (v1)' });
      return false;
    }
    const sess = new BrowserSession({
      connId,
      url,
      apiKey: this.apiKey,
      voiceConfig: this.voiceConfig,
      connectStt: this.connectStt,
      connectTts: this.connectTts,
      log: (level, msg) => this.log(level, `[conn ${connId}] ${msg}`),
      emitControl: (obj) => this._control(obj),
      emitBytes: (bytes) => {
        if (this.onSocketBytes) this.onSocketBytes(connId, bytes);
      },
      onClosed: (code, reason) => {
        const opened = sess.opened;
        this._forgetConn(connId);
        if (opened) {
          this._control({ type: 'socket.close', connId, code, reason });
        }
      },
    });
    this.conns.set(connId, sess);
    this.connOrder.push(connId);
    this.log('info', `conn '${connId}' attached`);
    return true;
  }

  detach(connId) {
    const sess = this.conns.get(connId);
    if (!sess) {
      this.log('debug', `detach for unknown conn '${connId}'`);
      return;
    }
    sess.detach();
    this._forgetConn(connId);
  }

  /**
   * Route one inbound tunnel record. v1 single conn: the first record's
   * connIdx is adopted (host convention: 1 for c1) and echoed outbound.
   */
  feedRecord(connIdx, payload) {
    let connId = this.connByIdx.get(connIdx);
    if (connId === undefined) {
      if (this.conns.size === 1) {
        const only = this.connOrder[0];
        const sess = this.conns.get(only);
        if (sess.connIdx === undefined) {
          sess.connIdx = connIdx;
          this.connByIdx.set(connIdx, only);
          this.log('debug', `conn '${only}' adopted connIdx ${connIdx}`);
          connId = only;
        }
      }
      if (connId === undefined) {
        this.log('warn', `record for unknown connIdx ${connIdx} dropped`);
        return;
      }
    }
    this._dispatch(connId, payload);
  }

  /** Direct dispatch by connId (kept for tests; entry uses feedRecord). */
  feedBytes(connId, payload) {
    this._dispatch(connId, payload);
  }

  /** Global teardown on 'stop'/stdin close: everything silent. */
  stop() {
    for (const [, sess] of this.conns) {
      sess.stop();
    }
    this.conns.clear();
    this.connOrder.length = 0;
    this.connByIdx.clear();
  }
}

module.exports = {
  HEARTBEAT_CHECK_MS,
  HEARTBEAT_TIMEOUT_MS,
  VALID_PATH,
  DEFAULT_CONN_IDX,
  parseTokenFromQuery,
  BrowserSession,
  Bridge,
};
