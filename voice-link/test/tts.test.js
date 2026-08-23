'use strict';

/** tts.js — stream-input TTS tests. Offline (fake WebSocket). */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TtsUtterance,
  chunkText,
  buildTtsUrl,
  initMessage,
  DEFAULT_MODEL,
  MAX_CHUNK,
  CHUNK_LENGTH_SCHEDULE,
} = require('../tts.js');
const { FakeWebSocket, resetFakes } = require('./helpers.js');

const LONG_SENTENCE = 'x'.repeat(500);

function makeUtterance(text, { apiKey = 'k', voiceId = 'v1', handlers = {}, opts = {} } = {}) {
  const ws = new FakeWebSocket('wss://api.elevenlabs.io/v1/text-to-speech/v1/stream-input');
  const connect = () => ws;
  const calls = { starts: 0, audio: [], canceleds: 0, errors: [] };
  const utter = new TtsUtterance({
    id: 'u1',
    apiKey,
    text,
    connect,
    handlers: {
      onStart: () => calls.starts++,
      onAudio: (b64, done) => calls.audio.push([b64, done]),
      onCanceled: () => calls.canceleds++,
      onError: (c, m) => calls.errors.push([c, m]),
      log: () => {},
      ...handlers,
    },
    opts: { voiceId, modelId: DEFAULT_MODEL, ...opts },
  });
  return { utter, ws, calls };
}

// ---------------------------------------------------------------- chunking

test('chunkText splits at sentence boundaries and repacks up to 200 chars', () => {
  const text =
    'First sentence here. Second sentence over there? Third one! And a fourth with enough words to push the packing logic across the two hundred character boundary so we actually get more than one chunk out of this.';
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.length <= 200));
  // Sentences stay whole when they fit.
  assert.ok(chunks[0].startsWith('First sentence here.'));
  const joined = chunks.join(' ');
  assert.equal(joined, text.replace(/\s+/g, ' ').trim());
});

test('chunkText handles CJK sentence punctuation', () => {
  const chunks = chunkText('你好世界。这是一个测试！第二句。');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], '你好世界。 这是一个测试！ 第二句。');
});

test('chunkText hard-splits an oversized sentence', () => {
  const chunks = chunkText(LONG_SENTENCE);
  assert.ok(chunks.every((c) => c.length <= MAX_CHUNK));
  assert.ok(chunks.length > 2);
  assert.equal(chunks.join(''), LONG_SENTENCE);
});

test('chunkText respects a custom maxChars', () => {
  const chunks = chunkText('abc def. ghi jkl.', { maxChars: 8 });
  assert.ok(chunks.every((c) => c.length <= 8));
});

test('chunkText of empty input returns []', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText(null), []);
});

test('buildTtsUrl embeds the voice id and model query', () => {
  const url = buildTtsUrl({ voiceId: 'v-123', modelId: 'eleven_flash_v2_5' });
  assert.equal(
    url,
    'wss://api.elevenlabs.io/v1/text-to-speech/v-123/stream-input?model_id=eleven_flash_v2_5&output_format=mp3_44100_128'
  );
});

test('init message carries settings, generation config and the key under both spellings', () => {
  const msg = JSON.parse(initMessage('sekret', {}));
  assert.equal(msg.text, ' ');
  assert.equal(msg.voice_settings.stability, 0.5);
  assert.equal(msg.voice_settings.similarity_boost, 0.75);
  assert.deepEqual(msg.generation_config.chunk_length_schedule, CHUNK_LENGTH_SCHEDULE);
  assert.equal(msg.xi_api_key, 'sekret');
  assert.equal(msg['xi-api-key'], 'sekret');
});

// ---------------------------------------------------------------- lifecycle

test('speak(): sends init frame, sentence chunks, then the empty-string close', () => {
  const { utter, ws, calls } = makeUtterance('Hello world. This is a test.');
  utter.speak();
  assert.equal(calls.starts, 0);
  ws._open();
  assert.equal(calls.starts, 1);
  const msgs = ws.sent.map((s) => JSON.parse(s));
  assert.equal(msgs.length, 3); // init + 1 packed chunk + close
  assert.equal(msgs[0].text, ' ');
  assert.equal(msgs[1].text, 'Hello world. This is a test.');
  assert.equal(msgs[2].text, '');
});

test('speak() splits a long utterance into multiple chunks', () => {
  const text =
    'First sentence here. Second sentence over there? Third one! And a fourth with enough words to push the packing logic across the two hundred character boundary so we actually get more than one chunk out of this.';
  const { utter, ws } = makeUtterance(text);
  utter.speak();
  ws._open();
  const msgs = ws.sent.map((s) => JSON.parse(s));
  // init + N chunks + close
  assert.ok(msgs.length >= 4, `expected >=4 messages, got ${msgs.length}`);
  for (const m of msgs.slice(1, -1)) assert.ok(m.text.length <= 200);
  assert.equal(msgs[msgs.length - 1].text, '');
});

test('audio chunks stream out; isFinal terminates with done=true and closes', () => {
  const { utter, ws, calls } = makeUtterance('hi there');
  utter.speak();
  ws._open();
  ws._messageText(JSON.stringify({ audio: 'QUJD' }));
  assert.deepEqual(calls.audio, [['QUJD', false]]);
  ws._messageText(JSON.stringify({ audio: 'REVG' }));
  assert.deepEqual(calls.audio, [['QUJD', false], ['REVG', false]]);
  ws._messageText(JSON.stringify({ isFinal: true }));
  assert.deepEqual(calls.audio, [['QUJD', false], ['REVG', false], ['', true]]);
  assert.equal(ws.closedWith.code, 1000, 'socket closed after final');
  // Alignment-only messages are ignored.
  ws._messageText(JSON.stringify({ normalizedAlignment: { chars: [] } }));
  assert.equal(calls.audio.length, 3);
});

test('missing API key → immediate tts_auth without connecting', () => {
  const { utter, calls } = makeUtterance('hi', { apiKey: '' });
  utter.speak();
  assert.deepEqual(calls.errors, [['tts_auth', 'ELEVENLABS_API_KEY is not set']]);
});

test('missing voiceId → tts_proto error', () => {
  const { utter, calls } = makeUtterance('hi', { voiceId: '' });
  utter.speak();
  assert.equal(calls.errors[0][0], 'tts_proto');
});

test('cancel() aborts the active utterance and emits exactly one tts.canceled', () => {
  const { utter, ws, calls } = makeUtterance('long utterance here.');
  utter.speak();
  ws._open();
  ws._messageText(JSON.stringify({ audio: 'A==' }));
  utter.cancel();
  assert.equal(calls.canceleds, 1);
  assert.equal(ws.closedWith.code, 1000);
  // Server audio after cancel is suppressed.
  ws._messageText(JSON.stringify({ audio: 'B==' }));
  ws._messageText(JSON.stringify({ isFinal: true }));
  assert.equal(calls.audio.length, 1);
  assert.equal(calls.errors.length, 0);
});

test('cancel() while connecting is honored on open', () => {
  const { utter, ws, calls } = makeUtterance('hi');
  utter.speak();
  utter.cancel();
  assert.equal(calls.canceleds, 1);
  ws._open();
  assert.equal(ws.sent.length, 0, 'no init/text sent for a canceled utterance');
  assert.equal(calls.starts, 0);
});

test('close with auth code 4001 → tts_auth', () => {
  const { utter, ws, calls } = makeUtterance('hi');
  utter.speak();
  ws._open();
  ws._closeServer(4001, 'unauthorized');
  assert.equal(calls.errors[0][0], 'tts_auth');
});

test('unexpected close (1006) → tts_net', () => {
  const { utter, ws, calls } = makeUtterance('hi');
  utter.speak();
  ws._open();
  ws._closeServer(1006, '');
  assert.equal(calls.errors[0][0], 'tts_net');
  assert.equal(calls.errors.length, 1);
});

test('close code 1002 → tts_proto', () => {
  const { utter, ws, calls } = makeUtterance('hi');
  utter.speak();
  ws._open();
  ws._closeServer(1002, 'protocol error');
  assert.equal(calls.errors[0][0], 'tts_proto');
});

test('non-JSON server message → tts_proto', () => {
  const { utter, ws, calls } = makeUtterance('hi');
  utter.speak();
  ws._open();
  ws._messageText('this is not json');
  assert.equal(calls.errors[0][0], 'tts_proto');
});

test('abort() is silent (no errors, no canceled)', () => {
  const { utter, ws, calls } = makeUtterance('hi');
  utter.speak();
  ws._open();
  utter.abort();
  assert.equal(calls.errors.length, 0);
  assert.equal(calls.canceleds, 0);
  assert.equal(calls.audio.length, 0);
});