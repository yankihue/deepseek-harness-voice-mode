'use strict';

/**
 * tunnel.js — Host ⇄ helper stdio framing (PROTOCOL.md §3).
 *
 * One pipe pair carries two kinds of records, distinguishable by the first
 * byte of every record:
 *
 *   - JSON control lines  : begin with '{', newline-delimited UTF-8.
 *   - binary byte records : begin with the 4-byte big-endian magic
 *                           0x0D51_0001 (first byte 0x0D, never '{').
 *
 * Binary record layout:
 *   record := magic(u32 BE = 0x0D51_0001) | connIdx(u8) | len(u32 BE) | payload(len bytes)
 *
 * The parser is a pure incremental state machine: feed() any number of
 * arbitrary byte chunks (splits may land anywhere) and it returns every
 * complete record that becomes available. The writer encodes both kinds.
 *
 * Zero npm dependencies. Node >= 22.
 */

const MAGIC = 0x0d510001;
const HEADER_LEN = 9; // 4 magic + 1 connIdx + 4 len
const MAX_RECORD_LEN = 64 * 1024 * 1024; // guard against bogus length prefixes

class TunnelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TunnelError';
  }
}

function magicBytes() {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(MAGIC, 0);
  return b;
}

/** Encode one binary byte-tunnel record (magic | connIdx | len | payload). */
function encodeRecord(connIdx, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const out = Buffer.allocUnsafe(HEADER_LEN + data.length);
  out.writeUInt32BE(MAGIC, 0);
  out.writeUInt8(connIdx & 0xff, 4);
  out.writeUInt32BE(data.length, 5);
  data.copy(out, HEADER_LEN);
  return out;
}

/**
 * Incremental parser over the mixed JSON-line / binary-record stream.
 *
 *   const parser = new TunnelParser();
 *   for (const ev of parser.feed(chunk)) { ... }
 *
 * Events:
 *   { kind: 'json',   obj: <parsed object> }
 *   { kind: 'record', connIdx: <number>, payload: <Buffer> }
 *
 * Throws TunnelError on malformed framing (bad magic, truncated length,
 * invalid JSON). A malformed stream is not recoverable — the caller should
 * treat it as a broken pipe.
 */
class TunnelParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  feed(chunk) {
    if (chunk && chunk.length > 0) {
      this.buf =
        this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    }
    const events = [];
    for (;;) {
      const buf = this.buf;
      if (buf.length === 0) break;

      const first = buf[0];
      if (first === 0x7b /* '{' */) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) break; // line incomplete
        const line = buf.subarray(0, nl);
        this.buf = buf.subarray(nl + 1);
        let obj;
        try {
          obj = JSON.parse(line.toString('utf8'));
        } catch (err) {
          throw new TunnelError(`malformed JSON control line: ${err.message}`);
        }
        events.push({ kind: 'json', obj });
        continue;
      }

      // Binary record
      const B = magicBytes();
      if (buf.length < HEADER_LEN) break;
      if (!buf.subarray(0, 4).equals(B)) {
        throw new TunnelError(`bad record magic 0x${buf.subarray(0, 4).toString('hex')}`);
      }
      const connIdx = buf[4];
      const len = buf.readUInt32BE(5);
      if (len > MAX_RECORD_LEN) {
        throw new TunnelError(`record length ${len} exceeds ${MAX_RECORD_LEN}`);
      }
      if (buf.length < HEADER_LEN + len) break;
      const payload = Buffer.from(buf.subarray(HEADER_LEN, HEADER_LEN + len));
      this.buf = buf.subarray(HEADER_LEN + len);
      events.push({ kind: 'record', connIdx, payload });
    }
    return events;
  }
}

/**
 * Writer that emits both JSON control lines and binary byte records.
 * `writeFn` is either a function taking a Buffer, or a stream-like object
 * with `.write(buffer)`.
 */
class TunnelWriter {
  constructor(writeFn) {
    this.writeFn = typeof writeFn === 'function' ? writeFn : (b) => writeFn.write(b);
  }

  json(obj) {
    this.writeFn(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'));
  }

  record(connIdx, payload) {
    this.writeFn(encodeRecord(connIdx, payload));
  }
}

module.exports = {
  MAGIC,
  HEADER_LEN,
  MAX_RECORD_LEN,
  TunnelError,
  encodeRecord,
  TunnelParser,
  TunnelWriter,
};