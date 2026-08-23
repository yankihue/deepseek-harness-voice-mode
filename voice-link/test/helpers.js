'use strict';

/**
 * test/helpers.js — offline test doubles shared across the suite.
 * No API keys, no network: injected via stt/tts/bridge/entry dependency
 * parameters in place of the real wsio.connectOutbound / process streams.
 */

const crypto = require('node:crypto');

/** Minimal WebSocket-shaped double (onopen/onmessage/onclose/onerror/send/close/abort). */
class FakeWebSocket {
  static instances = [];

  constructor(url, opts) {
    this.url = url;
    this.opts = opts || {};
    this.sent = [];
    this.readyState = 0; // CONNECTING
    this.binaryType = 'blob';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.closedWith = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    if (this.readyState > 1) {
      const err = new Error(`WebSocket is not open (readyState ${this.readyState})`);
      err.code = 'ERR_WS_NOT_OPEN';
      throw err;
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 2; // CLOSING
    this.closedWith = { code, reason };
    const ev = { code, reason, wasClean: code === 1000 };
    if (this.onclose) this.onclose(ev);
    this.readyState = 3;
  }

  abort() {
    this.readyState = 3; // silent teardown, no events
  }

  _open() {
    this.readyState = 1;
    if (this.onopen) this.onopen({});
  }

  _messageText(str) {
    if (this.onmessage) this.onmessage({ data: str, type: 'message' });
  }

  _messageBinary(buf) {
    const ab = new ArrayBuffer(buf.length);
    new Uint8Array(ab).set(Buffer.from(buf));
    if (this.onmessage) this.onmessage({ data: ab, type: 'message' });
  }

  _error() {
    if (this.onerror) this.onerror({ error: new Error('fake ws error'), message: 'fake ws error' });
  }

  _closeServer(code, reason) {
    if (this.onclose) this.onclose({ code, reason, wasClean: false });
    this.readyState = 3;
  }

  sentStrings() {
    return this.sent.map((s) => (typeof s === 'string' ? s : '<binary>'));
  }
}

function fakeConnectFactory(cls = FakeWebSocket) {
  return (url, opts) => new cls(url, opts);
}

/** Reset the shared instance list between tests. */
function resetFakes() {
  FakeWebSocket.instances.length = 0;
}

/** Random 4-byte WS masking key. */
function randomMaskKey() {
  return crypto.randomBytes(4);
}

/**
 * Build a client (masked) WS frame the way a browser would send it.
 * payload: string | Buffer
 */
function makeMaskedFrame(opcode, payload, { fin = true, maskKey = randomMaskKey() } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length <= 125) {
    header = Buffer.alloc(2);
    header[1] = data.length;
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(data.length / 4294967296), 2);
    header.writeUInt32BE(data.length % 4294967296, 6);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] |= 0x80; // MASK bit
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ maskKey[i & 3];
  return Buffer.concat([header, maskKey, masked]);
}

const TEXT = 0x1;
const BINARY = 0x2;
const CLOSE = 0x8;
const PING = 0x9;

/** Controlled async-iterable stdin for driving entry.run() offline. */
class FakeStdin {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.ended = false;
  }

  push(data) {
    this.queue.push(Buffer.from(data));
    this._drain();
  }

  end() {
    this.ended = true;
    this._drain();
  }

  _drain() {
    while (this.waiters.length > 0 && (this.queue.length > 0 || this.ended)) {
      const w = this.waiters.shift();
      w();
    }
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift();
        continue;
      }
      if (this.ended) return;
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }
}

/** Collecting Writable-like stdout. */
class FakeStdout {
  constructor() {
    this.chunks = [];
  }

  write(buf, cb) {
    this.chunks.push(Buffer.from(buf));
    if (typeof cb === 'function') queueMicrotask(cb);
    return true;
  }

  all() {
    return Buffer.concat(this.chunks);
  }
}

module.exports = {
  FakeWebSocket,
  fakeConnectFactory,
  resetFakes,
  randomMaskKey,
  makeMaskedFrame,
  TEXT,
  BINARY,
  CLOSE,
  PING,
  FakeStdin,
  FakeStdout,
};