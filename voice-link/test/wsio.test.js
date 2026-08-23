'use strict';

/** wsio.js — RFC6455 handshake + frame tests. Offline. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OP,
  WsProtocolError,
  computeAccept,
  parseHandshake,
  buildUpgradeResponse,
  buildHttpErrorResponse,
  buildClientRequest,
  parseHandshakeResponse,
  xorMask,
  encodeFrame,
  encodeText,
  encodeBinary,
  encodePing,
  encodePong,
  encodeClose,
  decodeClosePayload,
  FrameDecoder,
} = require('../wsio.js');

// ---------------------------------------------------------------- handshake

test('RFC6455 §1.3 accept-key vector', () => {
  assert.equal(computeAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

const RFC_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const RFC_ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';

function validRequest() {
  return (
    'GET /__dsh-voice/ws?t=abc123 HTTP/1.1\r\n' +
    'Host: 127.0.0.1:3080\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: keep-alive, Upgrade\r\n' +
    `Sec-WebSocket-Key: ${RFC_KEY}\r\n` +
    'Sec-WebSocket-Version: 13\r\n' +
    'Origin: http://127.0.0.1:3080\r\n\r\n'
  );
}

test('parseHandshake accepts a valid upgrade request', () => {
  const r = parseHandshake(Buffer.from(validRequest()));
  assert.ok(r);
  assert.equal(r.method, 'GET');
  assert.equal(r.path, '/__dsh-voice/ws');
  assert.equal(r.query, 't=abc123');
  assert.equal(r.key, RFC_KEY);
  assert.equal(r.headers['sec-websocket-version'], '13');
});

test('parseHandshake is incremental across chunks', () => {
  const buf = Buffer.from(validRequest());
  assert.equal(parseHandshake(buf.subarray(0, 20)), null);
  assert.equal(parseHandshake(buf.subarray(0, buf.length - 5)), null);
  const r = parseHandshake(buf);
  assert.ok(r && r.key === RFC_KEY);
});

test('parseHandshake rejects missing pieces', () => {
  assert.match(parseHandshake(Buffer.from('POST /x HTTP/1.1\r\n\r\n')).error, /GET/);
  assert.match(parseHandshake(Buffer.from('GET /x HTTP/1.1\r\nHost: h\r\n\r\n')).error, /Upgrade/);
  const noUpgrade = validRequest().replace('Upgrade: websocket\r\n', '');
  assert.match(parseHandshake(Buffer.from(noUpgrade)).error, /Upgrade/);
  const badKey = validRequest().replace(RFC_KEY, 'short');
  assert.match(parseHandshake(Buffer.from(badKey)).error, /Sec-WebSocket-Key/);
});

test('buildUpgradeResponse has the RFC accept value and CRLF framing', () => {
  const resp = buildUpgradeResponse(RFC_KEY).toString('ascii');
  assert.ok(resp.startsWith('HTTP/1.1 101 Switching Protocols\r\n'));
  assert.ok(resp.includes(`Sec-WebSocket-Accept: ${RFC_ACCEPT}\r\n\r\n`));
});

test('client request builder + response validator round-trip the RFC vector', () => {
  const req = buildClientRequest({
    url: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=x',
    key: RFC_KEY,
    headers: { 'xi-api-key': 'sekret' },
  }).toString('ascii');
  assert.ok(req.startsWith('GET /v1/speech-to-text/realtime?model_id=x HTTP/1.1\r\n'));
  assert.ok(req.includes('Upgrade: websocket\r\n'));
  assert.ok(req.includes('Connection: Upgrade\r\n'));
  assert.ok(req.includes(`Sec-WebSocket-Key: ${RFC_KEY}\r\n`));
  assert.ok(req.includes('xi-api-key: sekret\r\n'));

  const resp = buildUpgradeResponse(RFC_KEY);
  const parsed = parseHandshakeResponse(resp, RFC_KEY);
  assert.ok(parsed && parsed.status === 101);

  const parsedBad = parseHandshakeResponse(resp, 'wrong-key');
  assert.match(parsedBad.error, /mismatch/);
});

test('parseHandshakeResponse surfaces non-101 status (e.g. 401)', () => {
  const resp = Buffer.from('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
  const parsed = parseHandshakeResponse(resp, RFC_KEY);
  assert.equal(parsed.status, 401);
  assert.match(parsed.error, /401/);
});

test('buildHttpErrorResponse is a well-formed close response', () => {
  const resp = buildHttpErrorResponse(400, 'bad request').toString('ascii');
  assert.ok(resp.startsWith('HTTP/1.1 400 bad request\r\n'));
  assert.ok(resp.includes('Connection: close\r\n'));
});

// ------------------------------------------------------------------ frames

function frameRoundTrip(opcode, payload) {
  const enc = encodeFrame(opcode, payload);
  const dec = new FrameDecoder({ requireMask: false });
  const frames = dec.feed(enc);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, opcode);
  assert.equal(frames[0].fin, true);
  return frames[0].payload;
}

test('text frame round-trip (unmasked inbound)', () => {
  const out = frameRoundTrip(OP.TEXT, Buffer.from('{"a":1}'));
  assert.equal(out.toString(), '{"a":1}');
});

test('binary frame round-trip', () => {
  const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
  const out = frameRoundTrip(OP.BINARY, bytes);
  assert.deepEqual(out, bytes);
});

test('frame lengths cross the 125 and 65535 boundaries', () => {
  for (const n of [0, 1, 125, 126, 127, 65535, 65536, 70000]) {
    const payload = Buffer.alloc(n, 0x61);
    const frames = new FrameDecoder({ requireMask: false }).feed(encodeFrame(OP.BINARY, payload));
    assert.equal(frames[0].payload.length, n, `length ${n}`);
  }
});

test('masked inbound decoding (server side) with known pattern', () => {
  const payload = Buffer.from('ping!');
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  const masked = xorMask(payload, mask);
  const header = Buffer.from([0x81, 0x80 | payload.length]);
  const dec = new FrameDecoder({ requireMask: true });
  const frames = dec.feed(Buffer.concat([header, mask, masked]));
  assert.equal(frames[0].opcode, OP.TEXT);
  assert.equal(frames[0].payload.toString(), 'ping!');
});

test('server decoder rejects unmasked client frames', () => {
  const dec = new FrameDecoder({ requireMask: true });
  assert.throws(() => dec.feed(Buffer.from([0x81, 0x02, 0x68, 0x69])), WsProtocolError);
});

test('fragmented message reassembly (continuation frames)', () => {
  const dec = new FrameDecoder({ requireMask: false });
  const f1 = encodeFrame(OP.TEXT, Buffer.from('hel'), { fin: false });
  const f2 = encodeFrame(OP.CONTINUATION, Buffer.from('lo '), { fin: false });
  const f3 = encodeFrame(OP.CONTINUATION, Buffer.from('world'), { fin: true });
  const out = dec.feed(Buffer.concat([f1, f2, f3]));
  assert.equal(out.length, 1);
  assert.equal(out[0].opcode, OP.TEXT);
  assert.equal(out[0].payload.toString(), 'hello world');
});

test('orphan continuation frame is a protocol error', () => {
  const dec = new FrameDecoder({ requireMask: false });
  assert.throws(
    () => dec.feed(encodeFrame(OP.CONTINUATION, Buffer.from('x'), { fin: true })),
    WsProtocolError
  );
});

test('control frame over 125 bytes is a protocol error', () => {
  const dec = new FrameDecoder({ requireMask: false });
  assert.throws(() => dec.feed(encodeFrame(OP.PING, Buffer.alloc(126))), WsProtocolError);
});

test('RSV bits are rejected', () => {
  const bad = Buffer.from([0xc1, 0x01, 0x00]); // FIN + RSV1 + TEXT
  const dec = new FrameDecoder({ requireMask: false });
  assert.throws(() => dec.feed(bad), WsProtocolError);
});

test('close frame code/reason round-trip', () => {
  const enc = encodeClose(1001, 'going away');
  const dec = new FrameDecoder({ requireMask: false });
  const [frame] = dec.feed(enc);
  assert.equal(frame.opcode, OP.CLOSE);
  const { code, reason } = decodeClosePayload(frame.payload);
  assert.equal(code, 1001);
  assert.equal(reason, 'going away');
});

test('empty close payload decodes to code 1005', () => {
  assert.deepEqual(decodeClosePayload(Buffer.alloc(0)), { code: 1005, reason: '' });
});

test('ping/pong encoding decodes to correct opcodes', () => {
  const dec = new FrameDecoder({ requireMask: false });
  const [ping] = dec.feed(encodePing(Buffer.from('ts')));
  assert.equal(ping.opcode, OP.PING);
  assert.equal(ping.payload.toString(), 'ts');
  const [pong] = dec.feed(encodePong(Buffer.from('ts')));
  assert.equal(pong.opcode, OP.PONG);
});

test('text/binary helpers use correct opcodes', () => {
  const dec = new FrameDecoder({ requireMask: false });
  assert.equal(dec.feed(encodeText('x'))[0].opcode, OP.TEXT);
  assert.equal(dec.feed(encodeBinary(Buffer.from([1])))[0].opcode, OP.BINARY);
});

test('frame split mid-payload across feeds', () => {
  const enc = encodeFrame(OP.BINARY, Buffer.alloc(300, 0x42));
  const dec = new FrameDecoder({ requireMask: false });
  assert.equal(dec.feed(enc.subarray(0, 7)).length, 0);
  assert.equal(dec.feed(enc.subarray(7, 150)).length, 0);
  const frames = dec.feed(enc.subarray(150));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, 300);
});