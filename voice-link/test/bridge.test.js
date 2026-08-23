'use strict';

/** bridge.js — BrowserSession/Bridge tests (hello, heartbeat, routing). Offline. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { BrowserSession, Bridge, parseTokenFromQuery } = require('../bridge.js');
const wsio = require('../wsio.js');
const { OP, FrameDecoder, encodeText, buildClientRequest } = wsio;
const { FakeWebSocket, makeMaskedFrame, TEXT, BINARY, PING, resetFakes } = require('./helpers.js');

const RFC_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const TOKEN = 'tok-123';

/**
 * Decode outbound helper→host records (INTEGRATION.md §4.3/§4.5):
 *   - 'HTTP/1.1' prefix: raw handshake response bytes (relayed verbatim)
 *   - '{' first byte:    bare JSON text record → browser-bound WS text message
 *   - anything else:     complete framed WS message (close/pong control frames)
 */
function outboundFrames(bytes) {
  const dec = new FrameDecoder({ requireMask: false });
  const out = [];
  for (const b of bytes) {
    if (b.length >= 8 && b.subarray(0, 8).toString('ascii') === 'HTTP/1.1') continue;
    if (b.length > 0 && b[0] === 0x7b /* '{' */) {
      out.push(JSON.parse(b.toString('utf8')));
      continue;
    }
    for (const f of dec.feed(b)) {
      out.push(f.opcode === OP.TEXT ? JSON.parse(f.payload.toString('utf8')) : f);
    }
  }
  return out;
}

function makeSession(overrides = {}) {
  const controls = [];
  const bytesOut = [];
  const logs = [];
  const closedEvents = [];
  const sess = new BrowserSession({
    connId: 'c1',
    url: `/__dsh-voice/ws?t=${TOKEN}`,
    apiKey: overrides.apiKey !== undefined ? overrides.apiKey : 'k',
    voiceConfig: overrides.voiceConfig || { voiceId: 'v1' },
    connectStt: overrides.connectStt || (() => new FakeWebSocket('stt-url')),
    connectTts: overrides.connectTts || (() => new FakeWebSocket('tts-url')),
    log: (l, m) => logs.push([l, m]),
    emitControl: (o) => controls.push(o),
    emitBytes: (b) => bytesOut.push(Buffer.from(b)),
    onClosed: (code, reason) => closedEvents.push([code, reason]),
    hbCheckMs: overrides.hbCheckMs,
    hbTimeoutMs: overrides.hbTimeoutMs,
  });
  return { sess, controls, bytesOut, logs, closedEvents };
}

function doHandshake(sess) {
  sess.feedBytes(buildClientRequest({ url: `http://x/__dsh-voice/ws?t=${TOKEN}`, key: RFC_KEY, headers: {} }));
}

function sayHello(sess) {
  sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'hello', token: TOKEN, proto: 1 })));
}

test('parseTokenFromQuery extracts the one-time token', () => {
  assert.equal(parseTokenFromQuery('t=abc&x=1'), 'abc');
  assert.equal(parseTokenFromQuery('x=1'), undefined);
  assert.equal(parseTokenFromQuery(''), undefined);
});

test('handshake: 101 response with RFC accept + socket.open control', () => {
  const { sess, controls, bytesOut } = makeSession();
  doHandshake(sess);
  assert.deepEqual(controls, [{ type: 'socket.open', connId: 'c1' }]);
  const resp = bytesOut[0].toString('ascii');
  assert.ok(resp.startsWith('HTTP/1.1 101 Switching Protocols\r\n'), resp.slice(0, 30));
  assert.ok(resp.includes('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo='));
});

test('invalid handshake → HTTP 400 bytes + closed, no socket.open', () => {
  const { sess, controls, bytesOut, closedEvents } = makeSession();
  sess.feedBytes(Buffer.from('GET /x HTTP/1.1\r\nHost: h\r\n\r\n'));
  const resp = bytesOut[0].toString('ascii');
  assert.ok(resp.startsWith('HTTP/1.1 400 '), resp.slice(0, 30));
  assert.deepEqual(closedEvents, [[1006, 'handshake rejected: missing Upgrade: websocket']]);
  assert.equal(controls.length, 0);
});

test('hello with wrong token → auth error frame + shutdown', () => {
  const { sess, bytesOut, closedEvents } = makeSession();
  doHandshake(sess);
  sess.feedBytes(
    makeMaskedFrame(TEXT, JSON.stringify({ type: 'hello', token: 'WRONG-TOKEN', proto: 1 }))
  );
  const frames = outboundFrames(bytesOut);
  const text = frames.filter((f) => f && typeof f === 'object' && f.type === 'error');
  assert.equal(text[0].code, 'auth');
  assert.equal(text[0].fatal, true);
  assert.equal(closedEvents[0][0], 1008);
  assert.ok(closedEvents[0][1].includes('hello'));
});

test('hello before any data is required; audio before hello is dropped', () => {
  const { sess } = makeSession();
  doHandshake(sess);
  sess.feedBytes(makeMaskedFrame(BINARY, Buffer.from([0, 0, 0, 0])));
  // no STT session should exist yet
  assert.equal(sess.stt, null);
  sayHello(sess);
  assert.equal(sess.helloOk, true);
});

test('valid hello → ready + idle', () => {
  const { sess, bytesOut } = makeSession();
  doHandshake(sess);
  sayHello(sess);
  const msgs = outboundFrames(bytesOut).filter((m) => m && typeof m === 'object' && m.type);
  assert.deepEqual(msgs[0], { type: 'ready', proto: 1 });
  assert.deepEqual(msgs[1], { type: 'session.state', state: 'idle' });
});

test('ping → pong echoes ts', () => {
  const { sess, bytesOut } = makeSession();
  doHandshake(sess);
  sayHello(sess);
  const before = bytesOut.length;
  sess.feedBytes(makeMaskedFrame(PING, Buffer.from('')));
  sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'ping', ts: 42 })));
  const msgs = outboundFrames(bytesOut.slice(before)).filter((m) => typeof m === 'object');
  assert.ok(msgs.some((m) => m.type === 'pong' && m.ts === 42));
});

test('heartbeat: 30s of silence closes the peer (configurable for tests)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { sess, bytesOut, closedEvents } = makeSession({ hbCheckMs: 5, hbTimeoutMs: 30 });
    doHandshake(sess);
    sayHello(sess);
    t.mock.timers.tick(20); // still under timeout
    assert.equal(closedEvents.length, 0);
    t.mock.timers.tick(20); // now past 30ms of silence
    assert.equal(closedEvents.length, 1);
    assert.equal(closedEvents[0][0], 1000);
    assert.ok(closedEvents[0][1].includes('heartbeat'));
    // A close frame went back to the browser.
    const last = bytesOut[bytesOut.length - 1];
    const dec = new FrameDecoder({ requireMask: false });
    const frames = dec.feed(last);
    assert.ok(frames.some((f) => f.opcode === OP.CLOSE));
  } finally {
    t.mock.timers.reset();
  }
});

test('heartbeat is reset by incoming traffic', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { sess, closedEvents } = makeSession({ hbCheckMs: 5, hbTimeoutMs: 30 });
    doHandshake(sess);
    sayHello(sess);
    for (let i = 0; i < 10; i++) {
      t.mock.timers.tick(10);
      sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'ping', ts: i })));
    }
    assert.equal(closedEvents.length, 0, 'traffic should keep the session alive');
  } finally {
    t.mock.timers.reset();
  }
});

test('listen.start routes browser audio to the STT session (vad commit)', () => {
  let sttWs = null;
  const { sess } = makeSession({
    connectStt: (url, opts) => {
      sttWs = new FakeWebSocket(url, opts);
      return sttWs;
    },
  });
  doHandshake(sess);
  sayHello(sess);
  sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'listen.start', commit: 'vad', language: 'en' })));
  assert.ok(sess.stt, 'STT session created');
  sttWs._open();
  assert.equal(sess.listening, true);
  // Binary audio frames flow to Scribe as input_audio_chunk.
  const pcm = Buffer.alloc(64, 0xab);
  sess.feedBytes(makeMaskedFrame(BINARY, pcm));
  const sent = sttWs.sent.map((s) => JSON.parse(s));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_type, 'input_audio_chunk');
  assert.equal(sent[0].audio_base_64, pcm.toString('base64'));
  // The connect factory saw the xi-api-key header.
  assert.equal(sttWs.opts.headers['xi-api-key'], 'k');
});

test('listen.stop flushes + commits and returns to idle', () => {
  const sttWs = new FakeWebSocket('stt');
  const { sess, bytesOut } = makeSession({ connectStt: () => sttWs });
  doHandshake(sess);
  sayHello(sess);
  sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'listen.start', commit: 'manual' })));
  sttWs._open();
  sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'listen.stop' })));
  const msgs = sttWs.sent.map((s) => JSON.parse(s));
  assert.equal(msgs[msgs.length - 1].commit, true);
  const stateMsgs = outboundFrames(bytesOut).filter((m) => m && m.type === 'session.state');
  assert.equal(stateMsgs.at(-1).state, 'idle');
});

test('STT auth failure surfaces as stt.error with stt_auth code', () => {
  const sttWs = new FakeWebSocket('stt');
  const { sess, bytesOut } = makeSession({ connectStt: () => sttWs });
  doHandshake(sess);
  sayHello(sess);
  sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'listen.start', commit: 'vad' })));
  sttWs._open();
  sttWs._messageText(JSON.stringify({ message_type: 'auth_error', error: 'bad key' }));
  const errs = outboundFrames(bytesOut).filter((m) => m && typeof m === 'object' && m.type === 'stt.error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'stt_auth');
  assert.equal(sess.listening, false);
});

test('tts.speak → tts.start/audio/done + speaking/idle states', () => {
  const ttsWs = new FakeWebSocket('tts');
  const { sess, bytesOut } = makeSession({ connectTts: () => ttsWs });
  doHandshake(sess);
  sayHello(sess);
  sess.feedBytes(
    makeMaskedFrame(TEXT, JSON.stringify({ type: 'tts.speak', id: 'u1', text: 'Hello there.' }))
  );
  ttsWs._open();
  const msgs = outboundFrames(bytesOut).filter((m) => m && typeof m === 'object' && m.type);
  assert.ok(msgs.some((m) => m.type === 'tts.start' && m.id === 'u1'));
  assert.ok(msgs.some((m) => m.type === 'session.state' && m.state === 'speaking'));
  ttsWs._messageText(JSON.stringify({ audio: 'QUJD' }));
  ttsWs._messageText(JSON.stringify({ isFinal: true }));
  const audio = outboundFrames(bytesOut).filter((m) => m && m.type === 'tts.audio' && m.id === 'u1');
  assert.deepEqual(audio, [
    { type: 'tts.audio', id: 'u1', b64: 'QUJD', done: false },
    { type: 'tts.audio', id: 'u1', b64: '', done: true },
  ]);
  const states = outboundFrames(bytesOut).filter((m) => m && m.type === 'session.state');
  assert.equal(states.at(-1).state, 'idle');
});

test('tts.cancel without id cancels the current utterance', () => {
  const ttsWs = new FakeWebSocket('tts');
  const { sess, bytesOut } = makeSession({ connectTts: () => ttsWs });
  doHandshake(sess);
  sayHello(sess);
  sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'tts.speak', id: 'u1', text: 'hello' })));
  ttsWs._open();
  sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'tts.cancel' })));
  const canceled = outboundFrames(bytesOut).filter((m) => m && m.type === 'tts.canceled');
  assert.deepEqual(canceled, [{ type: 'tts.canceled', id: 'u1' }]);
});

test('tts.cancel with a specific id only cancels that utterance', () => {
  let n = 0;
  const { sess, bytesOut } = makeSession({ connectTts: () => new FakeWebSocket(`tts-${++n}`) });
  doHandshake(sess);
  sayHello(sess);
  sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'tts.speak', id: 'a', text: 'one' })));
  sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'tts.speak', id: 'b', text: 'two' })));
  sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'tts.cancel', id: 'a' })));
  const canceled = outboundFrames(bytesOut).filter((m) => m && m.type === 'tts.canceled');
  assert.deepEqual(canceled.map((m) => m.id), ['a']);
});

test('unexpected re-hello is refused', () => {
  const { sess, closedEvents } = makeSession();
  doHandshake(sess);
  sayHello(sess);
  sayHello(sess);
  assert.equal(closedEvents.length, 1);
  assert.equal(closedEvents[0][0], 1008);
});

test('detach tears down the STT/tts sessions silently', () => {
  const sttWs = new FakeWebSocket('stt');
  const ttsWs = new FakeWebSocket('tts');
  const { sess, closedEvents } = makeSession({
    connectStt: () => sttWs,
    connectTts: () => ttsWs,
  });
  doHandshake(sess);
  sayHello(sess);
  sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'listen.start', commit: 'vad' })));
  sttWs._open();
  sess.feedBytes(makeMaskedFrame(TEXT, JSON.stringify({ type: 'tts.speak', id: 'u1', text: 'x' })));
  sess.detach();
  assert.deepEqual(closedEvents, [[1006, 'detached']]);
  assert.equal(sttWs.readyState, 3);
  assert.equal(sess.ttsActive.size, 0);
});

// ------------------------------------------------------------------- Bridge

function makeBridge() {
  const controls = [];
  const outBytes = [];
  const bridge = new Bridge({
    apiKey: 'k',
    voiceConfig: { voiceId: 'v1' },
    connectStt: () => new FakeWebSocket('stt'),
    connectTts: () => new FakeWebSocket('tts'),
    log: () => {},
  });
  bridge.onControl = (o) => controls.push(o);
  bridge.onSocketBytes = (connId, b) => {
    outBytes.push([connId, Buffer.from(b)]);
  };
  return { bridge, controls, outBytes };
}

test('Bridge: attach → bytes → detach lifecycle with connIdx 1 (W2 convention)', () => {
  const { bridge, controls, outBytes } = makeBridge();
  assert.equal(bridge.attach('c1', `/__dsh-voice/ws?t=${TOKEN}`), true);
  assert.equal(bridge.connIndex('c1'), 1, 'default connIdx is 1 for the v1 conn');
  // First record (host rebuild of the upgrade request) adopts connIdx 1.
  bridge.feedRecord(
    1,
    buildClientRequest({ url: `http://x/__dsh-voice/ws?t=${TOKEN}`, key: RFC_KEY, headers: {} })
  );
  assert.deepEqual(controls[0], { type: 'socket.open', connId: 'c1' });
  assert.equal(bridge.connIndex('c1'), 1);
  bridge.feedRecord(1, makeMaskedFrame(TEXT, JSON.stringify({ type: 'hello', token: TOKEN, proto: 1 })));
  bridge.detach('c1');
  assert.equal(bridge.conns.size, 0);
  // socket.close only fires for conns that reached socket.open.
  const closes = controls.filter((c) => c.type === 'socket.close');
  assert.deepEqual(closes, [{ type: 'socket.close', connId: 'c1', code: 1006, reason: 'detached' }]);
  assert.equal(outBytes.length >= 1, true);
});

test('Bridge: a record with a second distinct connIdx is dropped after adoption', () => {
  const { bridge } = makeBridge();
  bridge.attach('c1', `/__dsh-voice/ws?t=${TOKEN}`);
  bridge.feedRecord(1, buildClientRequest({ url: `http://x/__dsh-voice/ws?t=${TOKEN}`, key: RFC_KEY, headers: {} }));
  bridge.feedRecord(2, Buffer.from([0xde, 0xad]));
  assert.equal(bridge.connIndex('c1'), 1, 'adopted connIdx stays 1');
});

test('host-injected tts.speak: bare JSON record works with no browser handshake/hello', () => {
  const ttsWs = new FakeWebSocket('tts');
  const { sess, bytesOut } = makeSession({ connectTts: () => ttsWs });
  // No handshake, no hello — the trusted host channel opens a TTS session.
  sess.injectJson(JSON.stringify({ type: 'tts.speak', id: 'q1', text: 'Hello there.', priority: 1 }));
  assert.ok(sess.ttsActive.has('q1'), 'injected tts.speak accepted pre-hello');
  ttsWs._open();
  const msgs = outboundFrames(bytesOut);
  assert.ok(msgs.some((m) => m.type === 'tts.start' && m.id === 'q1'));
  ttsWs._messageText(JSON.stringify({ audio: 'QUJD' }));
  ttsWs._messageText(JSON.stringify({ isFinal: true }));
  const terminals = outboundFrames(bytesOut).filter((m) => m.type === 'tts.audio' && m.id === 'q1');
  assert.deepEqual(terminals, [
    { type: 'tts.audio', id: 'q1', b64: 'QUJD', done: false },
    { type: 'tts.audio', id: 'q1', b64: '', done: true },
  ]);
  assert.equal(sess.ttsActive.has('q1'), false);
});

test('TTS failure emits tts.error{id} — the host queue terminal (INTEGRATION §4.6)', () => {
  const ttsWs = new FakeWebSocket('tts');
  const { sess, bytesOut } = makeSession({ connectTts: () => ttsWs });
  sess.injectJson(JSON.stringify({ type: 'tts.speak', id: 'q7', text: 'boom' }));
  ttsWs._open();
  ttsWs._closeServer(4001, 'unauthorized');
  const errs = outboundFrames(bytesOut).filter((m) => m && m.type === 'tts.error');
  assert.equal(errs.length, 1);
  assert.deepEqual(errs[0], { type: 'tts.error', id: 'q7', code: 'tts_auth', message: 'TTS socket closed with auth code 4001' });
  assert.equal(sess.ttsActive.has('q7'), false);
  // Exactly one terminal: no tts.canceled, no tts.audio done after the error.
  const terminals = outboundFrames(bytesOut).filter(
    (m) => m.type === 'tts.canceled' || (m.type === 'tts.audio' && m.done === true)
  );
  assert.equal(terminals.length, 0);
});

test('host-injected listen.start opens an STT session without browser hello', () => {
  const sttWs = new FakeWebSocket('stt');
  const { sess } = makeSession({ connectStt: () => sttWs });
  sess.injectJson(JSON.stringify({ type: 'listen.start', commit: 'manual' }));
  assert.ok(sess.stt, 'STT session created by host-injected listen.start');
  assert.equal(sess.listening, true);
});

test('Bridge: v1 refuses a second concurrent attach', () => {
  const { bridge, controls } = makeBridge();
  bridge.attach('c1', `/__dsh-voice/ws?t=${TOKEN}`);
  const ok = bridge.attach('c2', `/__dsh-voice/ws?t=${TOKEN}`);
  assert.equal(ok, false);
  const err = controls.find((c) => c.type === 'error');
  assert.equal(err.code, 'busy');
  assert.equal(bridge.conns.size, 1);
});

test('Bridge: stop() tears everything down silently', () => {
  const { bridge, controls } = makeBridge();
  bridge.attach('c1', `/__dsh-voice/ws?t=${TOKEN}`);
  bridge.feedBytes(
    'c1',
    buildClientRequest({ url: `http://x/__dsh-voice/ws?t=${TOKEN}`, key: RFC_KEY, headers: {} })
  );
  bridge.stop();
  assert.equal(bridge.conns.size, 0);
  const chatter = controls.filter((c) => c.type === 'socket.close');
  assert.equal(chatter.length, 0, 'global stop must not emit socket.close');
  resetFakes();
});