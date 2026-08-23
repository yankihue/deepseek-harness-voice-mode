'use strict';

/** stt.js — Scribe v2 Realtime client tests. Offline (fake WebSocket). */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SttSession,
  buildScribeUrl,
  audioChunkMessage,
  FORCE_COMMIT_AFTER_BYTES,
} = require('../stt.js');
const { FakeWebSocket, resetFakes } = require('./helpers.js');

function makeSession(handlers = {}, opts = {}) {
  const ws = new FakeWebSocket('wss://api.elevenlabs.io/v1/speech-to-text/realtime', { headers: {} });
  const connect = () => ws;
  const calls = { started: 0, partials: [], committed: [], errors: [], stopped: 0 };
  const sess = new SttSession({
    apiKey: opts.apiKey === undefined ? 'test-key' : opts.apiKey,
    connect,
    handlers: {
      onStarted: () => calls.started++,
      onPartial: (t) => calls.partials.push(t),
      onCommitted: (t) => calls.committed.push(t),
      onError: (c, m) => calls.errors.push([c, m]),
      onStopped: () => calls.stopped++,
      log: () => {},
      ...handlers,
    },
    opts: { commitStrategy: 'manual', forceCommitAfterBytes: opts.forceCommitAfterBytes, ...opts },
  });
  return { sess, ws, calls };
}

test('buildScribeUrl encodes all parameters', () => {
  const url = buildScribeUrl({ modelId: 'scribe_v2_realtime', commitStrategy: 'manual', languageCode: 'zh' });
  assert.equal(
    url,
    'wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&sample_rate=16000&commit_strategy=manual&language_code=zh'
  );
});

test('audio chunk message shape (verified against AsyncAPI)', () => {
  const msg = JSON.parse(audioChunkMessage('QUJD', false, 16000));
  assert.equal(msg.message_type, 'input_audio_chunk');
  assert.equal(msg.audio_base_64, 'QUJD');
  assert.equal(msg.commit, false);
  assert.equal(msg.sample_rate, 16000);
});

test('start() requires an API key (offline stt_auth path, no network)', () => {
  const { sess, calls } = makeSession({}, { apiKey: '' });
  sess.start();
  assert.deepEqual(calls.errors, [['stt_auth', 'ELEVENLABS_API_KEY is not set']]);
  assert.equal(calls.stopped, 1);
  assert.equal(sess.state, 'stopped');
});

test('audio chunks stream as base64 input_audio_chunk messages after open', () => {
  const { sess, ws, calls } = makeSession();
  sess.start();
  assert.equal(ws.sent.length, 0); // nothing before open
  ws._open();
  assert.equal(calls.started, 1);

  sess.feedAudio(Buffer.from([1, 2, 3]));
  assert.equal(ws.sent.length, 1);
  const m = JSON.parse(ws.sent[0]);
  assert.equal(m.message_type, 'input_audio_chunk');
  assert.equal(m.audio_base_64, Buffer.from([1, 2, 3]).toString('base64'));
  assert.equal(m.commit, false);
});

test('manual commit() sends a commit message', () => {
  const { sess, ws } = makeSession();
  sess.start();
  ws._open();
  sess.commit();
  const m = JSON.parse(ws.sent[ws.sent.length - 1]);
  assert.equal(m.audio_base_64, '');
  assert.equal(m.commit, true);
});

test('force-commit fires after >N bytes of streamed audio without a commit', () => {
  const { sess, ws } = makeSession({}, { forceCommitAfterBytes: 320 });
  sess.start();
  ws._open();
  sess.feedAudio(Buffer.alloc(100));
  sess.feedAudio(Buffer.alloc(200)); // 300 < 320: no commit yet
  assert.equal(ws.sent.length, 2);
  sess.feedAudio(Buffer.alloc(100)); // 400 >= 320 → chunk + trailing commit
  assert.equal(ws.sent.length, 4);
  const last = JSON.parse(ws.sent[3]);
  assert.equal(last.commit, true);
  assert.equal(last.audio_base_64, '');
  // Committed message resets the tracker.
  ws._messageText(JSON.stringify({ message_type: 'committed_transcript', text: 'x' }));
  sess.feedAudio(Buffer.alloc(10));
  assert.equal(JSON.parse(ws.sent[4]).commit, false);
});

test('partial/committed transcript mapping (straight through)', () => {
  const { sess, ws, calls } = makeSession();
  sess.start();
  ws._open();
  ws._messageText(JSON.stringify({ message_type: 'session_started', session_id: 's1', config: {} }));
  assert.equal(calls.started, 2); // open + session_started
  ws._messageText(JSON.stringify({ message_type: 'partial_transcript', text: 'hel' }));
  ws._messageText(JSON.stringify({ message_type: 'partial_transcript', text: 'hello' }));
  ws._messageText(JSON.stringify({ message_type: 'committed_transcript', text: 'hello world' }));
  ws._messageText(
    JSON.stringify({ message_type: 'committed_transcript_with_timestamps', text: 'hello world', words: [] })
  );
  assert.deepEqual(calls.partials, ['hel', 'hello']);
  assert.deepEqual(calls.committed, ['hello world', 'hello world']);
});

test('auth_error message → stt_auth, session stops (no reconnect)', () => {
  const { sess, ws, calls } = makeSession();
  sess.start();
  ws._open();
  ws._messageText(JSON.stringify({ message_type: 'auth_error', error: 'bad key' }));
  assert.deepEqual(calls.errors, [['stt_auth', 'Scribe error \'auth_error\': bad key']]);
  assert.equal(sess.state, 'stopped');
  assert.equal(calls.stopped, 1);
});

test('quota/rate_limited server errors classify as stt_proto and stop', () => {
  const { sess, ws, calls } = makeSession();
  sess.start();
  ws._open();
  ws._messageText(JSON.stringify({ message_type: 'quota_exceeded', error: 'no credits' }));
  assert.equal(calls.errors[0][0], 'stt_proto');
  assert.equal(sess.state, 'stopped');
});

test('non-JSON server message is dropped, not fatal', () => {
  const { sess, ws, calls } = makeSession();
  sess.start();
  ws._open();
  ws._messageText('not json at all');
  assert.equal(calls.errors.length, 0);
  assert.equal(sess.state, 'open');
});

test('close with auth code 4001 → stt_auth, no retry', () => {
  const { sess, ws, calls } = makeSession();
  sess.start();
  ws._open();
  ws._closeServer(4001, 'unauthorized');
  assert.deepEqual(calls.errors, [['stt_auth', 'STT socket closed with auth code 4001']]);
  assert.equal(sess.state, 'stopped');
});

test('unexpected close (1006) → one stt_net error + reconnect with backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    resetFakes();
    const connect = () => new FakeWebSocket('url');
    const calls = { errors: [], started: 0 };
    const sess = new SttSession({
      apiKey: 'k',
      connect,
      handlers: {
        onStarted: () => calls.started++,
        onError: (c, m) => calls.errors.push([c, m]),
        log: () => {},
      },
      opts: {},
    });
    sess.start();
    const first = FakeWebSocket.instances[0];
    first._open();
    assert.equal(calls.started, 1);
    first._closeServer(1006, '');
    assert.equal(calls.errors.length, 1);
    assert.equal(calls.errors[0][0], 'stt_net');
    assert.equal(FakeWebSocket.instances.length, 1);
    // First retry delay is 500ms.
    t.mock.timers.tick(500);
    assert.equal(FakeWebSocket.instances.length, 2, 'reconnect attempted after backoff');
    const second = FakeWebSocket.instances[1];
    second._open();
    assert.equal(calls.started, 2);
    // Stop now: no more retries.
    sess.stop();
    t.mock.timers.tick(60000);
    assert.equal(FakeWebSocket.instances.length, 2);
  } finally {
    t.mock.timers.reset();
    resetFakes();
  }
});

test('listen.stop flushes a final commit, waits for the final transcript, then closes; never reconnects', async () => {
  const { sess, ws, calls } = makeSession();
  sess.start();
  ws._open();
  sess.feedAudio(Buffer.alloc(64));
  sess.stop();
  const msgs = ws.sent.map((s) => JSON.parse(s));
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].commit, false);
  assert.equal(msgs[1].commit, true);
  assert.equal(calls.stopped, 1);
  // Socket stays alive during the stop grace window (final commit in flight).
  assert.equal(ws.closedWith, null);
  ws._messageText(JSON.stringify({ message_type: 'committed_transcript', text: 'final' }));
  assert.equal(calls.committed.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ws.closedWith.code, 1000); // early teardown after final transcript
  assert.equal(sess.state, 'stopped');
  // Close event arriving after stop() is ignored (no reconnect, no error).
  ws._closeServer(1006, 'late');
  assert.equal(calls.errors.length, 0);
});

test('listen.stop tears down via the grace window when no final commit arrives', async () => {
  const { sess, ws, calls } = makeSession();
  sess.start();
  ws._open();
  sess.stop();
  assert.equal(calls.stopped, 1);
  assert.equal(ws.closedWith, null);
  await new Promise((resolve) => setTimeout(resolve, 1700)); // > STOP_GRACE_MS
  assert.equal(ws.closedWith.code, 1000);
  assert.equal(sess.state, 'stopped');
  assert.equal(calls.errors.length, 0);
});

test('abort() tears down without error events', () => {
  const { sess, ws, calls } = makeSession();
  sess.start();
  ws._open();
  sess.abort();
  assert.equal(calls.errors.length, 0);
  assert.equal(sess.state, 'stopped');
});

test('audio fed while connecting is buffered and replayed on open', async () => {
  const { sess, ws } = makeSession();
  sess.start(); // connecting
  sess.feedAudio(Buffer.alloc(128));
  assert.equal(ws.sent.length, 0);
  ws._open();
  // Replay is deferred off the upgrade tick (TLS-safe); settle one macrotask.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ws.sent.length, 1);
  const m = JSON.parse(ws.sent[0]);
  assert.equal(m.audio_base_64, Buffer.alloc(128).toString('base64'));
  assert.equal(m.commit, false);
});

test('auth flows through the xi-api-key header to the connect factory', () => {
  let captured = null;
  const ws = new FakeWebSocket('url');
  const connect = (url, opts) => {
    captured = opts;
    return ws;
  };
  const sess = new SttSession({ apiKey: 'k-123', connect, handlers: { log: () => {} }, opts: {} });
  sess.start();
  assert.equal(captured.headers['xi-api-key'], 'k-123');
});

test('default force-commit threshold is 20s of 16kHz PCM', () => {
  assert.equal(FORCE_COMMIT_AFTER_BYTES, 32000 * 20);
});