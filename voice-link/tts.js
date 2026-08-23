'use strict';

/**
 * tts.js — ElevenLabs stream-input TTS (one WS per utterance).
 *
 * Wire format verified against the AsyncAPI reference
 * (/v1/text-to-speech/{voice_id}/stream-input) and the realtime-TTS guide:
 *
 *   URL:  wss://api.elevenlabs.io/v1/text-to-speech/<voiceId>/stream-input?model_id=<model>
 *   Init: {"text":" ","voice_settings":{...},"generation_config":
 *         {"chunk_length_schedule":[120,160,250,290]},"xi_api_key":KEY}
 *   Text: {"text":"<chunk>"}      (sentence-bounded, ≤ MAX_CHUNK chars)
 *   End:  {"text":""}
 *   Resp: {"audio":"<base64 mp3>"}   → each tts.audio chunk
 *         {"isFinal":true}           → tts.audio{done:true}, then close
 *
 * Per PROTOCOL.md §2 the auth goes in the first frame; we send the key under
 * BOTH "xi_api_key" (live docs guide) and "xi-api-key" (AsyncAPI schema) for
 * forward/backward compatibility. Never logged.
 *
 * Chunking: split at sentence boundaries (incl. CJK punctuation), pack
 * sentences greedily up to MAX_CHUNK chars, hard-split oversized sentences
 * at the last whitespace within the window (else raw cut).
 *
 * Zero npm dependencies. Node >= 22.
 */

const DEFAULT_MODEL = 'eleven_flash_v2_5';
const MAX_CHUNK = 200;
const CHUNK_LENGTH_SCHEDULE = [120, 160, 250, 290];

const DEFAULT_VOICE_SETTINGS = Object.freeze({
  stability: 0.5,
  similarity_boost: 0.75,
  use_speaker_boost: true,
});

const AUTH_CLOSE_CODES = new Set([4001, 4002, 4003, 4401, 4403, 4004, 4404]);

// Sentence break: ASCII terminal punctuation followed by whitespace (so
// "e.g." / "3.14" stay intact), or CJK terminal punctuation which always ends
// a sentence. Newlines collapse to a single space for synthesis.
const SENTENCE_BREAK = /(?<=[.!?…])(?=\s)|(?<=[。！？])/;

/**
 * Split text into sentence-bounded chunks of at most maxChars characters.
 * Pure and testable. Spacing between sentences is normalized to a single
 * space; oversized sentences are hard-split at the last word boundary within
 * the window (else raw cut).
 *
 *   chunkText("Hello world. How are you? Fine.") → ["Hello world. How are you?", "Fine."]
 *   chunkText("你好世界。这是第二句。")            → ["你好世界。 这是第二句。"]
 */
function chunkText(text, { maxChars = MAX_CHUNK } = {}) {
  if (!text) return [];
  const normalized = String(text)
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return [];
  const sentences = normalized.split(SENTENCE_BREAK).filter((s) => s.length > 0);
  const chunks = [];
  let acc = '';
  const push = (s) => {
    const t = s.trim();
    if (t.length) chunks.push(t);
  };
  for (const raw of sentences) {
    let sent = raw.trim();
    if (sent.length > maxChars) {
      push(acc);
      acc = '';
      while (sent.length > maxChars) {
        const slice = sent.slice(0, maxChars);
        const ws = slice.lastIndexOf(' ');
        const cut = ws > 0 ? ws : maxChars;
        push(sent.slice(0, cut));
        sent = sent.slice(cut).trimStart();
      }
      acc = sent;
      continue;
    }
    if (acc && acc.length + sent.length + 1 > maxChars) {
      push(acc);
      acc = sent;
    } else {
      acc = acc ? `${acc} ${sent}` : sent;
    }
  }
  push(acc);
  return chunks;
}

/** Build the stream-input TTS WS URL (pure, testable). */
function buildTtsUrl({ voiceId, modelId = DEFAULT_MODEL }) {
  return (
    `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
    `/stream-input?model_id=${encodeURIComponent(modelId)}&output_format=mp3_44100_128`
  );
}

function initMessage(apiKey, voiceSettings) {
  const msg = {
    text: ' ',
    voice_settings: { ...DEFAULT_VOICE_SETTINGS, ...voiceSettings },
    generation_config: { chunk_length_schedule: CHUNK_LENGTH_SCHEDULE },
  };
  // Auth in the first frame: both spellings seen in ElevenLabs docs.
  msg.xi_api_key = apiKey;
  msg['xi-api-key'] = apiKey;
  return JSON.stringify(msg);
}

/**
 * One utterance = one TTS socket.
 *
 * handlers (all optional):
 *   onStart()             socket open, init+text sent
 *   onAudio(b64, done)    one mp3 chunk; done=true terminates the utterance
 *   onCanceled()          utterance aborted by tts.cancel
 *   onError(code, msg)    tts_auth | tts_net | tts_proto (exact codes)
 *   log(level, msg)
 *
 * opts: voiceId, modelId, voiceSettings.
 */
class TtsUtterance {
  constructor({ id, apiKey, text, connect, handlers = {}, opts = {} }) {
    this.id = id;
    this.apiKey = apiKey;
    this.text = text;
    this.connect = connect;
    this.h = handlers;
    this.o = opts;
    this.ws = null;
    this.state = 'idle'; // idle|connecting|open|done|canceled|failed
    this.canceled = false;
    this.finalized = false;
    this._log = (level, msg) => {
      try {
        this.h.log?.(level, msg);
      } catch (_) {
        /* ignore */
      }
    };
  }

  _emit(event, ...args) {
    try {
      this.h[event]?.(...args);
    } catch (_) {
      /* ignore */
    }
  }

  _emitError(code, message) {
    if (this.canceled || this.finalized || this.state === 'failed') return;
    this.state = 'failed';
    this._log('error', `TTS '${code}': ${message}`);
    this._emit('onError', code, message);
    this._teardown();
  }

  _teardown() {
    if (this.ws) {
      try {
        this.ws.abort?.();
      } catch (_) {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /** Start synthesis for this utterance. */
  speak() {
    if (!this.apiKey) {
      this._emitError('tts_auth', 'ELEVENLABS_API_KEY is not set');
      return;
    }
    if (!this.o.voiceId) {
      this._emitError('tts_proto', 'no voiceId configured (ELEVENLABS_VOICE_ID)');
      return;
    }
    const url = buildTtsUrl({ voiceId: this.o.voiceId, modelId: this.o.modelId || DEFAULT_MODEL });
    this._log('debug', `TTS connect url=${url} hasKey=${!!this.apiKey} keyLen=${(this.apiKey||'').length}`);
    let ws;
    try {
      // Auth MUST be present at upgrade time (the gateway 403s otherwise);
      // the init-frame key field alone is not sufficient.
      ws = this.connect(url, { headers: { 'xi-api-key': this.apiKey } });
    } catch (err) {
      this._emitError('tts_net', `TTS connect threw synchronously: ${err.message}`);
      return;
    }
    this.ws = ws;
    this.state = 'connecting';
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this._onOpen(url);
    ws.onmessage = (ev) => this._onMessage(ev.data);
    ws.onclose = (ev) => this._onClose(ev);
    ws.onerror = () => this._log('debug', 'TTS socket error event');
  }

  _onOpen(url) {
    if (this.canceled) {
      // Canceled while connecting: go straight to teardown.
      this.state = 'canceled';
      this.finalized = true;
      try {
        this.ws.abort?.();
        this.ws.close?.(1000, 'canceled');
      } catch (_) {
        /* ignore */
      }
      this.ws = null;
      this._emit('onCanceled');
      return;
    }
    this.state = 'open';
    try {
      this.ws.send(initMessage(this.apiKey, this.o.voiceSettings));
      const chunks = chunkText(this.text, { maxChars: this.o.maxChars || MAX_CHUNK });
      if (chunks.length === 0) {
        this.ws.send(JSON.stringify({ text: '' }));
      } else {
        for (const chunk of chunks) this.ws.send(JSON.stringify({ text: chunk }));
        this.ws.send(JSON.stringify({ text: '' }));
      }
      this._log('debug', `TTS ${this.id}: sent ${chunks.length} chunk(s)`);
    } catch (err) {
      this._emitError('tts_proto', `failed to send TTS input: ${err.message}`);
      return;
    }
    this._emit('onStart');
  }

  _onMessage(data) {
    if (this.canceled || this.finalized) return;
    if (typeof data !== 'string') return; // TTS server sends text frames only
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      this._emitError('tts_proto', `non-JSON TTS message: ${err.message}`);
      return;
    }
    if (msg && typeof msg.audio === 'string' && msg.audio.length) {
      this._emit('onAudio', msg.audio, false);
    }
    if (msg && msg.isFinal === true) {
      this.finalized = true;
      this.state = 'done';
      this._emit('onAudio', '', true);
      try {
        this.ws.close(1000, 'done');
      } catch (_) {
        /* ignore */
      }
    }
    // normalizedAlignment / alignment / generated_text messages: ignored.
  }

  _onClose(ev = {}) {
    const wasIntentional = this.canceled || this.finalized || this.state === 'done';
    if (wasIntentional) return;
    const code = typeof ev.code === 'number' ? ev.code : 1006;
    const reason = String(ev.reason || '');
    this.ws = null;
    if (AUTH_CLOSE_CODES.has(code)) {
      this._emitError('tts_auth', `TTS socket closed with auth code ${code}`);
      return;
    }
    if (code === 1002 || /protocol|invalid/i.test(reason)) {
      this._emitError('tts_proto', `TTS protocol close (${code}): ${reason}`);
      return;
    }
    this._emitError('tts_net', `TTS socket closed unexpectedly (${code}${reason ? `: ${reason}` : ''})`);
  }

  /** Abort this utterance (tts.cancel). Emits onCanceled exactly once. */
  cancel() {
    if (this.canceled || this.finalized || this.state === 'failed' || this.state === 'done') {
      return; // Unknown id or already terminal: nothing to abort.
    }
    this.canceled = true;
    this.state = 'canceled';
    this._log('debug', `TTS ${this.id} canceled`);
    if (this.ws) {
      try {
        this.ws.close(1000, 'canceled');
      } catch (_) {
        /* ignore */
      }
      try {
        this.ws.abort?.();
      } catch (_) {
        /* ignore */
      }
      this.ws = null;
    }
    this._emit('onCanceled');
  }

  /** Silent teardown for socket-level end (browser closed / helper stop). */
  abort() {
    this.canceled = true;
    this.finalized = true;
    this.state = 'done';
    if (this.ws) {
      try {
        this.ws.abort?.();
      } catch (_) {
        /* ignore */
      }
      this.ws = null;
    }
  }
}

module.exports = {
  DEFAULT_MODEL,
  MAX_CHUNK,
  CHUNK_LENGTH_SCHEDULE,
  DEFAULT_VOICE_SETTINGS,
  AUTH_CLOSE_CODES,
  chunkText,
  buildTtsUrl,
  initMessage,
  TtsUtterance,
};