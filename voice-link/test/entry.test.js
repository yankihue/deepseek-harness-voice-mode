'use strict';

/**
 * entry.js — full offline lifecycle through the real stdio tunnel:
 * init → ready → attach → WS handshake → hello → listen.start →
 * mocked STT auth failure → stt.error(stt_auth) over the browser socket →
 * ping/pong → stop → stopped. No network, no API key required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { run } = require('../entry.js');
const { TunnelParser, encodeRecord } = require('../tunnel.js');
const { FrameDecoder, OP, buildClientRequest } = require('../wsio.js');
const {
  FakeWebSocket,
  FakeStdin,
  FakeStdout,
  makeMaskedFrame,
  TEXT,
  resetFakes,
} = require('./helpers.js');

const RFC_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const TOKEN = 'tok-abc';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeStdout(stdout) {
  const parser = new TunnelParser();
  const events = parser.feed(stdout.all());
  const json = events.filter((e) => e.kind === 'json').map((e) => e.obj);
  const recs = events
    .filter((e) => e.kind === 'record')
    .map((e) => ({ connIdx: e.connIdx, payload: e.payload }));
  const frames = [];
  for (const { payload } of recs) {
    if (payload.length >= 8 && payload.subarray(0, 8).toString('ascii') === 'HTTP/1.1') continue;
    if (payload.length > 0 && payload[0] === 0x7b /* '{' → bare JSON text record */) {
      frames.push(JSON.parse(payload.toString('utf8')));
      continue;
    }
    const dec = new FrameDecoder({ requireMask: false });
    for (const f of dec.feed(payload)) {
      frames.push(f.opcode === OP.TEXT ? JSON.parse(f.payload.toString('utf8')) : f);
    }
  }
  return { json, recs, frames };
}

test('boot: no API key still reaches ready, then stops cleanly', async () => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const stderr = new FakeStdout();
  const connectStt = () => {
    throw new Error('must not connect without a key');
  };
  const runPromise = run({
    stdin,
    stdout,
    stderr,
    connectStt,
    connectTts: () => new FakeWebSocket('tts'),
    env: {}, // no ELEVENLABS_API_KEY
    exit: () => {},
  });

  stdin.push('{"type":"init","proto":1,"logLevel":"info"}\n');
  await sleep(20);
  const mid = decodeStdout(stdout);
  assert.ok(mid.json.some((o) => o.type === 'ready' && o.proto === 1 && typeof o.pid === 'number'));
  assert.ok(mid.json.some((o) => o.type === 'stopped') === false);

  stdin.push('{"type":"stop"}\n');
  await runPromise;
  const final = decodeStdout(stdout);
  assert.ok(final.json.some((o) => o.type === 'stopped'));
});

test('full voice session: auth failure on a mocked STT emits stt.error stt_auth', async () => {
  resetFakes();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const stderr = new FakeStdout();
  let sttWs = null;
  const connectStt = (url, opts) => {
    sttWs = new FakeWebSocket(url, opts);
    return sttWs;
  };
  const runPromise = run({
    stdin,
    stdout,
    stderr,
    connectStt,
    connectTts: (url) => new FakeWebSocket(url),
    env: { ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_VOICE_ID: 'v1' },
    exit: () => {},
  });

  stdin.push('{"type":"init","proto":1,"logLevel":"info"}\n');
  await sleep(20);
  stdin.push('{"type":"socket.attach","connId":"c1","url":"/__dsh-voice/ws?t=tok-abc"}\n');
  await sleep(20);

  // Browser → helper: raw HTTP upgrade request through the byte tunnel.
  stdin.push(
    encodeRecord(1, buildClientRequest({ url: `http://x/__dsh-voice/ws?t=${TOKEN}`, key: RFC_KEY, headers: {} }))
  );
  await sleep(20);

  let out = decodeStdout(stdout);
  assert.ok(out.json.some((o) => o.type === 'socket.open' && o.connId === 'c1'));
  assert.ok(
    out.recs[0].payload.toString('ascii').includes('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo='),
    '101 response carries the RFC accept key'
  );

  // hello
  stdin.push(
    encodeRecord(1, makeMaskedFrame(TEXT, JSON.stringify({ type: 'hello', token: TOKEN, proto: 1 })))
  );
  await sleep(20);
  out = decodeStdout(stdout);
  assert.ok(out.frames.some((m) => m.type === 'ready' && m.proto === 1));
  assert.ok(out.frames.some((m) => m.type === 'session.state' && m.state === 'idle'));

  // listen.start → mocked Scribe ws opens → server auth_error
  stdin.push(encodeRecord(1, makeMaskedFrame(TEXT, JSON.stringify({ type: 'listen.start', commit: 'vad' }))));
  await sleep(20);
  assert.ok(sttWs, 'STT socket created');
  assert.equal(sttWs.opts.headers['xi-api-key'], 'test-key');
  sttWs._open();
  sttWs._messageText(JSON.stringify({ message_type: 'auth_error', error: 'invalid key' }));
  await sleep(20);

  out = decodeStdout(stdout);
  const sttErrors = out.frames.filter((m) => m && m.type === 'stt.error');
  assert.equal(sttErrors.length, 1);
  assert.equal(sttErrors[0].code, 'stt_auth');
  assert.equal(sttErrors[0].message.includes('auth'), true);

  // ping → pong
  stdin.push(encodeRecord(1, makeMaskedFrame(TEXT, JSON.stringify({ type: 'ping', ts: 1234 }))));
  await sleep(20);
  out = decodeStdout(stdout);
  assert.ok(out.frames.some((m) => m.type === 'pong' && m.ts === 1234));
  // Every outbound browser-bound record rides connIdx 1 (W2 convention).
  assert.ok(out.recs.length > 0);
  assert.ok(out.recs.every((r) => r.connIdx === 1), 'all tunnel records use connIdx 1');

  // stop → clean shutdown, stopped emitted, run() resolves
  stdin.push('{"type":"stop"}\n');
  await runPromise;
  out = decodeStdout(stdout);
  assert.ok(out.json.some((o) => o.type === 'stopped'));
});

test('host-injected tts.speak via tunnel: bare JSON record → tts.start/audio → done terminal → stop', async () => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const stderr = new FakeStdout();
  let ttsWs = null;
  const runPromise = run({
    stdin,
    stdout,
    stderr,
    connectStt: () => new FakeWebSocket('stt'),
    connectTts: (url) => {
      ttsWs = new FakeWebSocket(url);
      return ttsWs;
    },
    env: { ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v1' },
    exit: () => {},
  });

  stdin.push('{"type":"init","proto":1}\n');
  await sleep(20);
  stdin.push('{"type":"socket.attach","connId":"c1","url":"/__dsh-voice/ws?t=tok-abc"}\n');
  await sleep(20);

  // Host injects tts.speak as a bare JSON tunnel record (INTEGRATION §4.5) —
  // no browser handshake/hello needed on this trusted channel.
  stdin.push(encodeRecord(1, Buffer.from('{"type":"tts.speak","id":"q1","text":"Hi there.","priority":1}')));
  await sleep(20);
  assert.ok(ttsWs, 'TTS socket created by injected control');
  ttsWs._open();
  ttsWs._messageText(JSON.stringify({ audio: 'QUJD' }));
  ttsWs._messageText(JSON.stringify({ isFinal: true }));
  await sleep(20);

  const out = decodeStdout(stdout);
  assert.ok(out.frames.some((m) => m.type === 'tts.start' && m.id === 'q1'));
  assert.ok(out.frames.some((m) => m.type === 'tts.audio' && m.id === 'q1' && m.b64 === 'QUJD' && m.done === false));
  assert.ok(out.frames.some((m) => m.type === 'tts.audio' && m.id === 'q1' && m.done === true));
  // Exactly one terminal for q1 (done), never duplicated.
  const terminals = out.frames.filter(
    (m) => (m.type === 'tts.audio' && m.done === true) || m.type === 'tts.canceled' || m.type === 'tts.error'
  );
  assert.equal(terminals.filter((m) => m.id === 'q1').length, 1);

  stdin.push('{"type":"stop"}\n');
  await runPromise;
  assert.ok(decodeStdout(stdout).json.some((o) => o.type === 'stopped'));
});

test('missing API key classifies a listen.start as stt_auth without network', async () => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  let connected = false;
  const runPromise = run({
    stdin,
    stdout,
    connectStt: () => {
      connected = true;
      return new FakeWebSocket('stt');
    },
    connectTts: () => new FakeWebSocket('tts'),
    env: {}, // no key
    exit: () => {},
  });

  stdin.push('{"type":"init","proto":1}\n');
  await sleep(20);
  stdin.push('{"type":"socket.attach","connId":"c1","url":"/__dsh-voice/ws?t=tok-abc"}\n');
  await sleep(20);
  stdin.push(
    encodeRecord(1, buildClientRequest({ url: `http://x/__dsh-voice/ws?t=${TOKEN}`, key: RFC_KEY, headers: {} }))
  );
  await sleep(20);
  stdin.push(encodeRecord(1, makeMaskedFrame(TEXT, JSON.stringify({ type: 'hello', token: TOKEN, proto: 1 }))));
  await sleep(20);
  stdin.push(encodeRecord(1, makeMaskedFrame(TEXT, JSON.stringify({ type: 'listen.start', commit: 'vad' }))));
  await sleep(20);

  assert.equal(connected, false, 'no network attempt without a key');
  const out = decodeStdout(stdout);
  const errs = out.frames.filter((m) => m && m.type === 'stt.error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'stt_auth');

  stdin.push('{"type":"stop"}\n');
  await runPromise;
});

test('malformed control line stops the helper gracefully', async () => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const stderr = new FakeStdout();
  const runPromise = run({
    stdin,
    stdout,
    stderr,
    connectStt: () => new FakeWebSocket('stt'),
    connectTts: () => new FakeWebSocket('tts'),
    env: { ELEVENLABS_API_KEY: 'k' },
    exit: () => {},
  });
  stdin.push('{"type":"init","proto":1}\n');
  await sleep(20);
  stdin.push(Buffer.from('{definitely not json}\n'));
  await runPromise;
  const out = decodeStdout(stdout);
  assert.ok(out.json.some((o) => o.type === 'stopped'));
});