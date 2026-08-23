'use strict';

/** tunnel.js — byte-tunnel framing tests (PROTOCOL.md §3). Offline. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAGIC,
  HEADER_LEN,
  TunnelError,
  encodeRecord,
  TunnelParser,
  TunnelWriter,
} = require('../tunnel.js');

function collect(events) {
  return events;
}

test('encodeRecord layout: magic BE + connIdx + len BE + payload', () => {
  const payload = Buffer.from([1, 2, 3, 4, 5]);
  const rec = encodeRecord(0, payload);
  assert.equal(rec.length, HEADER_LEN + 5);
  assert.equal(rec.readUInt32BE(0), MAGIC);
  assert.equal(rec[4], 0);
  assert.equal(rec.readUInt32BE(5), 5);
  assert.deepEqual([...rec.subarray(9)], [1, 2, 3, 4, 5]);
});

test('record round-trip with connIdx', () => {
  const payload = Buffer.from('hello tunnel bytes');
  const rec = encodeRecord(7, payload);
  const parser = new TunnelParser();
  const events = parser.feed(rec);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'record');
  assert.equal(events[0].connIdx, 7);
  assert.deepEqual(events[0].payload, payload);
});

test('JSON line round-trip', () => {
  const writer = new TunnelWriter((b) => {
    const parser = new TunnelParser();
    const events = parser.feed(b);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'json');
    assert.deepEqual(events[0].obj, { type: 'init', proto: 1, logLevel: 'info' });
  });
  writer.json({ type: 'init', proto: 1, logLevel: 'info' });
});

test('interleaved JSON lines and binary records decode in order', () => {
  const payload = Buffer.from('raw socket bytes');
  const chunks = [
    Buffer.from('{"type":"init","proto":1}\n'),
    encodeRecord(0, payload),
    Buffer.from('{"type":"socket.attach","connId":"c1","url":"/x"}\n'),
    encodeRecord(0, Buffer.from('more')),
    Buffer.from('{"type":"stop"}\n'),
  ];
  const parser = new TunnelParser();
  const events = collect(parser.feed(Buffer.concat(chunks)));
  assert.deepEqual(
    events.map((e) => e.kind),
    ['json', 'record', 'json', 'record', 'json']
  );
  assert.equal(events[0].obj.type, 'init');
  assert.deepEqual(events[1].payload, payload);
  assert.equal(events[2].obj.type, 'socket.attach');
  assert.deepEqual(events[3].payload, Buffer.from('more'));
  assert.equal(events[4].obj.type, 'stop');
});

test('chunked feeds: split inside header, inside payload, across JSON newline', () => {
  const json = Buffer.from('{"type":"ready","proto":1}\n');
  const rec = encodeRecord(0, Buffer.from('0123456789'));
  const blob = Buffer.concat([json, rec]);
  const parser = new TunnelParser();
  const events = [];
  // Feed 1 byte at a time; results must aggregate identically.
  for (const byte of blob) {
    events.push(...parser.feed(Buffer.from([byte])));
  }
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'json');
  assert.deepEqual(events[0].obj, { type: 'ready', proto: 1 });
  assert.equal(events[1].kind, 'record');
  assert.equal(events[1].payload.toString(), '0123456789');
});

test('line can arrive in several chunks', () => {
  const parser = new TunnelParser();
  assert.equal(parser.feed(Buffer.from('{"type":"init"')).length, 0);
  assert.equal(parser.feed(Buffer.from(',"proto":1}\n')).length, 1);
  const events = parser.feed(Buffer.from('{"type":"stop"}\n'));
  assert.equal(events[0].obj.type, 'stop');
});

test('bad magic on a non-JSON record is a TunnelError', () => {
  const parser = new TunnelParser();
  const bad = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0, 2, 1, 2]);
  assert.throws(() => parser.feed(bad), TunnelError);
});

test('truncated length prefix waits for more bytes', () => {
  const parser = new TunnelParser();
  const rec = encodeRecord(0, Buffer.from('abc'));
  // Feed header only (9 bytes) → must buffer, no events, no throw.
  assert.equal(parser.feed(rec.subarray(0, HEADER_LEN)).length, 0);
  assert.equal(parser.feed(rec.subarray(HEADER_LEN, HEADER_LEN + 2)).length, 0);
  assert.equal(parser.feed(rec.subarray(HEADER_LEN + 2)).length, 1);
});

test('malformed JSON control line is a TunnelError', () => {
  const parser = new TunnelParser();
  assert.throws(() => parser.feed(Buffer.from('{not json}\n')), TunnelError);
});

test('oversized length prefix is rejected', () => {
  const parser = new TunnelParser();
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt32BE(MAGIC, 0);
  header.writeUInt8(0, 4);
  header.writeUInt32BE(0x7fffffff, 5);
  assert.throws(() => parser.feed(header), TunnelError);
});

test('zero-length payload record', () => {
  const rec = encodeRecord(0, Buffer.alloc(0));
  const parser = new TunnelParser();
  const events = parser.feed(rec);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, Buffer.alloc(0));
});