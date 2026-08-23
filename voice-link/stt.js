'use strict';

/**
 * stt.js — Scribe v2 Realtime (streaming STT) client body.
 *
 * Wire format verified against the ElevenLabs AsyncAPI reference
 * (/v1/speech-to-text/realtime) and the server-side streaming guide:
 *
 *   URL:    wss://api.elevenlabs.io/v1/speech-to-text/realtime
 *           ?model_id=scribe_v2_realtime&audio_format=pcm_16000
 *           &sample_rate=16000&commit_strategy=vad|manual[&language_code=xx]
 *   Auth:   xi-api-key header (PROTOCOL.md §2). Node's global WebSocket cannot
 *           set headers → the caller injects a `connect` factory (entry.js
 *           passes wsio.connectOutbound; tests pass a fake WebSocket).
 *   Audio:  {"message_type":"input_audio_chunk","audio_base_64":<b64>,
 *            "commit":false,"sample_rate":16000}
 *   Commit: same message with audio_base_64="" and commit=true
 *   Server: session_started | partial_transcript | committed_transcript |
 *           committed_transcript_with_timestamps | error | auth_error | ...
 *
 * Behaviors per PROTOCOL.md §2:
 *   - vad (default) or manual commit strategy
 *   - force-commit after >20 s of streamed audio with no commit
 *     (640 KB = 16000 Hz × 2 B × 20 s; model force-commits ~36 s, we stay ahead)
 *   - reconnect with exponential backoff on unplanned close
 *   - error classification: stt_auth / stt_net / stt_proto (exact codes)
 *   - never logs the API key
 *
 * Zero npm dependencies. Node >= 22.
 */

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 32000
const FORCE_COMMIT_AFTER_BYTES = BYTES_PER_SECOND * 20; // 640000
const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];
/** Grace window after a flush commit before the socket is torn down (ms). */
const STOP_GRACE_MS = 1500;
const MAX_PENDING_BYTES = 4 * 1024 * 1024; // replay buffer cap while reconnecting
const AUTH_CLOSE_CODES = new Set([4001, 4002, 4003, 4401, 4403, 4004, 4404]);

const SERVER_ERROR_MAP = {
  auth_error: 'stt_auth',
  unaccepted_terms: 'stt_auth',
  quota_exceeded: 'stt_proto',
  rate_limited: 'stt_proto',
  resource_exhausted: 'stt_proto',
  queue_overflow: 'stt_proto',
  session_time_limit_exceeded: 'stt_proto',
  input_error: 'stt_proto',
  invalid_request: 'stt_proto',
  chunk_size_exceeded: 'stt_proto',
  insufficient_audio_activity: 'stt_proto',
  commit_throttled: 'stt_proto',
  transcriber_error: 'stt_proto',
  error: 'stt_proto',
};

/** Build the Scribe realtime WS URL (pure, testable). */
function buildScribeUrl({
  modelId = 'scribe_v2_realtime',
  audioFormat = 'pcm_16000',
  sampleRate = SAMPLE_RATE,
  commitStrategy = 'vad',
  languageCode,
} = {}) {
  const q = new URLSearchParams({
    model_id: modelId,
    audio_format: audioFormat,
    sample_rate: String(sampleRate),
    commit_strategy: commitStrategy,
  });
  if (languageCode) q.set('language_code', languageCode);
  return `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${q.toString()}`;
}

function audioChunkMessage(b64, commit, sampleRate) {
  return JSON.stringify({
    message_type: 'input_audio_chunk',
    audio_base_64: b64,
    commit: commit,
    sample_rate: sampleRate,
  });
}

/**
 * One Scribe listen session.
 *
 * handlers (all optional):
 *   onStarted(info)          session_started (fresh server session)
 *   onPartial(text)          partial_transcript
 *   onCommitted(text)        committed (maps with- and without-timestamps)
 *   onError(code, message)   stt_auth | stt_net | stt_proto
 *   onStopped()              session fully stopped (normal or after abort)
 *   log(level, msg)          diagnostics (never contains the key)
 *
 * opts: modelId, audioFormat, sampleRate, commitStrategy, languageCode,
 *       forceCommitAfterBytes (default FORCE_COMMIT_AFTER_BYTES)
 */
class SttSession {
  constructor({ apiKey, voice, connect, handlers = {}, opts = {} }) {
    this.apiKey = apiKey;
    this.voice = voice; // VoiceSession context, unused directly
    this.connect = connect;
    this.h = handlers;
    this.o = opts;
    this.sampleRate = opts.sampleRate || SAMPLE_RATE;
    this.forceCommitBytes = opts.forceCommitAfterBytes || FORCE_COMMIT_AFTER_BYTES;

    this.state = 'idle'; // idle|connecting|open|stopping|stopped
    this.ws = null;
    this.handshakeDone = false;
    this.pending = []; // audio buffered while (re)connecting
    this.pendingBytes = 0;
    this.bytesSinceCommit = 0;
    this.retryAttempt = 0;
    this.retryTimer = null;
    this._emitErrorOnce = null; // net-error dedupe per disconnect episode
    this.stopped = false;
    this._log = (level, msg) => {
      try {
        this.h.log?.(level, msg);
      } catch (_) {
        /* ignore logging failures */
      }
    };
  }

  _emit(event, ...args) {
    try {
      this.h[event]?.(...args);
    } catch (_) {
      /* handler failures must not kill the session */
    }
  }

  /** Begin (or resume for reconnect) the listen session. */
  start() {
    if (this.stopped) return;
    if (!this.apiKey) {
      // Short-circuit: never touch the network without a key (also the
      // offline "mocked STT failure" path used by acceptance tests).
      this._log('warn', 'ELEVENLABS_API_KEY not set; refusing STT session');
      this.state = 'stopped';
      this.stopped = true;
      this._emit('onError', 'stt_auth', 'ELEVENLABS_API_KEY is not set');
      this._emit('onStopped');
      return;
    }
    this._connectNow();
  }

  _connectNow() {
    if (this.stopped || this.state === 'stopped') return;
    this.state = 'connecting';
    const url = buildScribeUrl({
      modelId: this.o.modelId,
      audioFormat: this.o.audioFormat,
      sampleRate: this.sampleRate,
      commitStrategy: this.o.commitStrategy || 'vad',
      languageCode: this.o.languageCode,
    });
    let ws;
    try {
      ws = this.connect(url, { headers: { 'xi-api-key': this.apiKey } });
    } catch (err) {
      this._log('error', `STT connect threw synchronously: ${err.message}`);
      this._scheduleRetry(err);
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this._onOpen();
    ws.onmessage = (ev) => this._onMessage(ev.data);
    ws.onclose = (ev) => this._onClose(ev);
    ws.onerror = (ev) => {
      /* Node fires error then close; classification happens in _onClose */
      const detail = ev && ev.error ? ev.error.message : ev && ev.message ? ev.message : 'unknown';
      this._log('debug', `STT socket error event: ${detail}`);
    };
  }

  _onOpen() {
    if (this.stopped) return;
    this.state = 'open';
    this.handshakeDone = true;
    this.retryAttempt = 0;
    this._emitErrorOnce = null;
    // Replay anything buffered while we were down (PCM is idempotent).
    // Deferred off the 'upgrade' event tick: blasting large frames into the
    // socket synchronously inside the http upgrade callback corrupts the TLS
    // stream (observed: OpenSSL "bad record mac" on the next server read).
    if (this.pending.length) {
      const replay = this.pending;
      this.pending = [];
      const replayedBytes = this.pendingBytes;
      this.pendingBytes = 0;
      setImmediate(() => {
        if (this.stopped || this.state !== 'open') return;
        try {
          for (const chunk of replay) this._sendAudioChunk(chunk, false);
        } catch (err) {
          this._log('warn', `STT replay failed: ${err && err.message}`);
          return;
        }
        this._log('debug', `STT replayed ${replayedBytes} buffered bytes`);
        this.bytesSinceCommit = replayedBytes;
        if (this.bytesSinceCommit >= this.forceCommitBytes) this.commit();
      });
    }
    this._emit('onStarted', { sessionId: undefined });
  }

  /** Feed raw PCM16 bytes (from a browser binary WS frame). */
  feedAudio(pcmBytes) {
    if (this.stopped || this.state === 'stopped') return;
    const buf = Buffer.isBuffer(pcmBytes) ? pcmBytes : Buffer.from(pcmBytes);
    if (this.state !== 'open' || !this.handshakeDone) {
      // Reconnect in progress: buffer for replay (bounded).
      if (this.pendingBytes + buf.length > MAX_PENDING_BYTES) {
        const drop = buf.length;
        this._log('warn', `STT replay buffer full; dropping ${drop} bytes of audio`);
        return;
      }
      this.pending.push(buf);
      this.pendingBytes += buf.length;
      return;
    }
    this._sendAudioChunk(buf, false);
  }

  _sendAudioChunk(pcm, commit) {
    if (this.state !== 'open' || !this.ws) return;
    const b64 = Buffer.from(pcm).toString('base64');
    this.ws.send(audioChunkMessage(b64, commit, this.sampleRate));
    if (!commit) {
      this.bytesSinceCommit += pcm.length;
      if (this.bytesSinceCommit >= this.forceCommitBytes) {
        this._log('debug', `force-commit after ${this.bytesSinceCommit} bytes of audio`);
        this.commit();
      }
    } else {
      this.bytesSinceCommit = 0;
    }
  }

  /** Explicit commit (manual strategy / listen.stop flush). */
  commit() {
    if (this.state !== 'open' || !this.ws) return;
    this.ws.send(audioChunkMessage('', true, this.sampleRate));
    this.bytesSinceCommit = 0;
  }

  /**
   * End the listen session: flush + commit, then close. No reconnect.
   * Safe to call from any state.
   */
  stop() {
    if (this.stopped || this._stopPending) return;
    // Grace-window stop: send the flush commit, report stopped to the FSM
    // immediately, but keep the socket alive briefly so the server's FINAL
    // committed transcript can arrive before teardown. Closing immediately
    // races that message (and truncates its TLS record mid-read).
    this._clearRetry();
    if (this.state === 'open' && this.ws) {
      this._stopPending = true;
      try {
        this.commit();
      } catch (_) {
        /* ignore */
      }
      this.state = 'stopped';
      this._emit('onStopped');
      this._stopTimer = setTimeout(() => this._finishStop(), STOP_GRACE_MS);
      this._stopTimer.unref?.();
    } else if (this.state === 'connecting' && this.ws) {
      this.stopped = true;
      try {
        this.ws.abort?.();
        this.ws.close?.(1000, 'listen.stop');
      } catch (_) {
        /* ignore */
      }
      this.state = 'stopped';
      this.ws = null;
      this._emit('onStopped');
    } else {
      this.stopped = true;
      this.state = 'stopped';
      this.ws = null;
      this._emit('onStopped');
    }
  }

  /** Teardown after the stop grace window (or early, on final commit). */
  _finishStop() {
    if (this._stopTimer) {
      clearTimeout(this._stopTimer);
      this._stopTimer = null;
    }
    this._stopPending = false;
    this.stopped = true;
    this.state = 'stopped';
    if (this.ws) {
      try {
        this.ws.close(1000, 'listen.stop');
      } catch (_) {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /** Abrupt teardown (socket died / browser closed): no commit, no errors. */
  abort() {
    const wasActive = this.state === 'open' || this.state === 'connecting';
    this.stopped = true;
    this._clearRetry();
    if (this.ws) {
      try {
        this.ws.abort?.();
      } catch (_) {
        /* ignore */
      }
    }
    this.state = 'stopped';
    this.ws = null;
    if (wasActive) this._emit('onStopped');
  }

  _clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this._stopTimer) {
      clearTimeout(this._stopTimer);
      this._stopTimer = null;
    }
  }

  _onMessage(data) {
    if (this.stopped) {
      // late frames from a dying socket; drop and close
      if (this.ws) {
        try {
          this.ws.abort?.();
        } catch (_) {
          /* ignore */
        }
      }
      return;
    }
    let msg;
    if (typeof data === 'string') {
      try {
        msg = JSON.parse(data);
      } catch (err) {
        this._log('warn', `STT non-JSON message dropped: ${err.message}`);
        return;
      }
    } else {
      this._log('warn', 'STT received unexpected binary frame');
      return;
    }
    const type = msg.message_type;
    switch (type) {
      case 'session_started':
        this._emit('onStarted', { sessionId: msg.session_id, config: msg.config });
        break;
      case 'partial_transcript':
        if (typeof msg.text === 'string' && msg.text.length) this._emit('onPartial', msg.text);
        break;
      case 'committed_transcript':
      case 'committed_transcript_with_timestamps':
        if (typeof msg.text === 'string' && msg.text.length) {
          this.bytesSinceCommit = 0;
          this._emit('onCommitted', msg.text);
          // Final transcript of a stop flush: teardown can proceed now.
          if (this._stopPending) this._finishStop();
        }
        break;
      default: {
        // Everything else is an error family (ScribeError + friends).
        const code = SERVER_ERROR_MAP[type];
        if (code) {
          this._log('warn', `STT server error '${type}': ${String(msg.error || '')}`);
          this._fatal(code, `Scribe error '${type}': ${String(msg.error || '')}`);
        } else {
          this._log('debug', `STT unknown message_type '${type}' ignored`);
        }
      }
    }
  }

  _onClose(ev = {}) {
    if (this.stopped) return; // stop()/abort() already handled
    const code = typeof ev.code === 'number' ? ev.code : 1006;
    const reason = String(ev.reason || '');
    this.ws = null;

    if (AUTH_CLOSE_CODES.has(code)) {
      this._fatal('stt_auth', `STT socket closed with auth code ${code}`);
      return;
    }
    if (code === 1002 || /protocol|invalid/i.test(reason)) {
      this._fatal('stt_proto', `STT protocol close (${code}): ${reason}`);
      return;
    }
    // Unplanned close → net error (reported once per episode) + reconnect.
    if (!this._emitErrorOnce) {
      this._emitErrorOnce = true;
      this._emit('onError', 'stt_net', `STT socket closed unexpectedly (${code}${reason ? `: ${reason}` : ''})`);
    }
    this._scheduleRetry(null);
  }

  _fatal(code, message) {
    this._clearRetry();
    this.stopped = true;
    this.state = 'stopped';
    if (this.ws) {
      try {
        this.ws.abort?.();
      } catch (_) {
        /* ignore */
      }
      this.ws = null;
    }
    this._log('error', `STT fatal: ${message}`);
    this._emit('onError', code, message);
    this._emit('onStopped');
  }

  _scheduleRetry(err) {
    if (this.stopped || this.state === 'stopped') return;
    const delay = RETRY_DELAYS[Math.min(this.retryAttempt, RETRY_DELAYS.length - 1)];
    this.retryAttempt += 1;
    this.state = 'reconnecting';
    this._log('debug', `STT reconnect in ${delay}ms (attempt ${this.retryAttempt})${err ? `: ${err.message}` : ''}`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this._connectNow();
    }, delay);
  }
}

module.exports = {
  SAMPLE_RATE,
  BYTES_PER_SECOND,
  FORCE_COMMIT_AFTER_BYTES,
  RETRY_DELAYS,
  MAX_PENDING_BYTES,
  AUTH_CLOSE_CODES,
  SERVER_ERROR_MAP,
  buildScribeUrl,
  audioChunkMessage,
  SttSession,
};