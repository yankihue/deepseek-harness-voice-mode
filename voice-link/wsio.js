'use strict';

/**
 * wsio.js — minimal RFC6455 WebSocket support, zero dependencies.
 *
 * Server side (browser ⇄ helper):
 *   - parseHandshake(buf)      : incremental HTTP-upgrade request parser
 *   - computeAccept(key)       : Sec-WebSocket-Accept (SHA-1 + base64)
 *   - buildUpgradeResponse(key): 101 Switching Protocols response bytes
 *   - FrameDecoder             : incremental unmask/fragment/reassemble inbound frames
 *   - encodeFrame / encodeText / encodeBinary / encodePing / encodePong / encodeClose
 *
 * Client side (helper ⇄ ElevenLabs / generic outbound WSS):
 *   Node's global WebSocket (undici) cannot set request headers, and
 *   PROTOCOL.md §2 requires the `xi-api-key` header for STT. connectOutbound()
 *   opens a node:https upgrade request, validates the 101 + accept, and returns
 *   a WebSocket-shaped object (onopen/onmessage/onclose/onerror/send/close/binaryType)
 *   so STT/TTS callers can swap in a fake WebSocket in offline tests.
 *
 * Known RFC 6455 test vector (used in tests):
 *   key    dGhlIHNhbXBsZSBub25jZQ==
 *   accept s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
 *
 * Only node builtins: node:crypto (SHA-1), node:https, node:url.
 */

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

const OPCODES = new Set([0, 1, 2, 8, 9, 10]);

const MAX_CONTROL_PAYLOAD = 125;
const MAX_FRAME_LEN = 64 * 1024 * 1024; // 64 MiB guard against allocation bombs

class WsProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WsProtocolError';
  }
}

/** RFC6455 §1.3 accept-key computation. */
function computeAccept(key) {
  return crypto.createHash('sha1').update(key + GUID, 'utf8').digest('base64');
}

/**
 * Parse an HTTP Upgrade request from buffered bytes.
 * Returns null when more bytes are needed, or:
 *   { method, path, query, headers, key }           success
 *   { error: <reason string> }                      invalid request
 */
function parseHandshake(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const idx = buf.indexOf('\r\n\r\n');
  if (idx === -1) return null;
  const head = buf.subarray(0, idx).toString('latin1');
  const lines = head.split('\r\n');
  const reqLine = lines[0];
  const m = /^([A-Z]+)\s+(\S+)\s+HTTP\/1\.[01]$/.exec(reqLine);
  if (!m) return { error: `bad request line: ${reqLine}` };
  const method = m[1];
  const target = m[2];
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const ci = line.indexOf(':');
    if (ci === -1) continue;
    const name = line.slice(0, ci).trim().toLowerCase();
    const val = line.slice(ci + 1).trim();
    headers[name] = headers[name] === undefined ? val : `${headers[name]}, ${val}`;
  }
  const key = headers['sec-websocket-key'];
  const qIdx = target.indexOf('?');
  const path = qIdx === -1 ? target : target.slice(0, qIdx);
  const query = qIdx === -1 ? '' : target.slice(qIdx + 1);

  if (method !== 'GET') return { error: `method must be GET, got ${method}` };
  const upgrade = headers['upgrade'] || '';
  if (!/websocket/i.test(upgrade)) return { error: 'missing Upgrade: websocket' };
  const connTokens = (headers['connection'] || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());
  if (!connTokens.includes('upgrade')) return { error: 'missing Connection: Upgrade' };
  if (!key || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    return { error: 'invalid/missing Sec-WebSocket-Key' };
  }
  if (headers['sec-websocket-version'] && headers['sec-websocket-version'] !== '13') {
    return { error: `unsupported Sec-WebSocket-Version ${headers['sec-websocket-version']}` };
  }
  return { method, path, query, headers, key };
}

/** Build the 101 Switching Protocols response for an accepted key. */
function buildUpgradeResponse(key) {
  return Buffer.from(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`,
    'ascii'
  );
}

/** Build a plain HTTP error response (for rejected handshakes). */
function buildHttpErrorResponse(status, reason) {
  const body = `${status} ${reason}\n`;
  return Buffer.from(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
    'ascii'
  );
}

/**
 * Build a client-side Upgrade request (bytes sent by connectOutbound).
 * Pure and testable.
 */
function buildClientRequest({ url, key, headers = {} }) {
  const u = new URL(url);
  const host = u.host; // includes port when non-default
  const path = u.pathname + u.search;
  const extra = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (extra) lines.push(extra);
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'ascii');
}

/**
 * Parse the server's handshake response. Returns null when incomplete, or
 *   { status, headers }                success
 *   { error: <reason> }                malformed / wrong status
 * `expectedKey` (when given) is validated against Sec-WebSocket-Accept.
 */
function parseHandshakeResponse(buf, expectedKey) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const idx = buf.indexOf('\r\n\r\n');
  if (idx === -1) return null;
  const head = buf.subarray(0, idx).toString('latin1');
  const lines = head.split('\r\n');
  const m = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/.exec(lines[0]);
  if (!m) return { error: `bad status line: ${lines[0]}` };
  const status = Number(m[1]);
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const ci = line.indexOf(':');
    if (ci === -1) continue;
    const name = line.slice(0, ci).trim().toLowerCase();
    const val = line.slice(ci + 1).trim();
    headers[name] = headers[name] === undefined ? val : `${headers[name]}, ${val}`;
  }
  if (status !== 101) return { status, headers, error: `unexpected status ${status}` };
  if (expectedKey !== undefined) {
    const expected = computeAccept(expectedKey);
    const got = headers['sec-websocket-accept'];
    if (!got || got !== expected) return { status, headers, error: 'Sec-WebSocket-Accept mismatch' };
  }
  return { status, headers };
}

/** XOR a frame payload with its 4-byte masking key (RFC6455 §5.3). */
function xorMask(data, key) {
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i & 3];
  return out;
}

/**
 * Encode one outbound (unmasked) frame.
 * payload: Buffer | Uint8Array | string
 */
function encodeFrame(opcode, payload, { fin = true, mask = false } = {}) {
  const data = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload.buffer ? new Uint8Array(payload) : payload);
  const len = data.length;
  const first = (fin ? 0x80 : 0) | opcode;
  let header;
  if (len <= 125) {
    header = Buffer.allocUnsafe(2);
    header[0] = first;
    header[1] = len | (mask ? 0x80 : 0);
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = first;
    header[1] = 126 | (mask ? 0x80 : 0);
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = first;
    header[1] = 127 | (mask ? 0x80 : 0);
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len % 4294967296, 6);
  }
  // RFC 6455 §5.3: client→server frames MUST be masked; server→client MUST NOT be.
  if (mask) {
    const maskKey = crypto.randomBytes(4);
    return Buffer.concat([header, maskKey, xorMask(data, maskKey)]);
  }
  return Buffer.concat([header, data]);
}

function encodeText(str, opts) {
  return encodeFrame(OP.TEXT, Buffer.from(str, 'utf8'), opts);
}

function encodeBinary(data, opts) {
  return encodeFrame(OP.BINARY, Buffer.from(data), opts);
}

function encodePing(payload = Buffer.alloc(0), opts) {
  return encodeFrame(OP.PING, payload, opts);
}

function encodePong(payload = Buffer.alloc(0), opts) {
  return encodeFrame(OP.PONG, payload, opts);
}

/** Close frame payload = 2-byte BE code + UTF-8 reason. */
function encodeClose(code = 1000, reason = '', opts) {
  const r = Buffer.from(reason, 'utf8');
  const payload = Buffer.allocUnsafe(2 + r.length);
  payload.writeUInt16BE(code, 0);
  r.copy(payload, 2);
  return encodeFrame(OP.CLOSE, payload, opts);
}

/** Decode a close-frame payload into { code, reason }. Empty payload ⇒ code 1005. */
function decodeClosePayload(payload) {
  if (!payload || payload.length === 0) return { code: 1005, reason: '' };
  if (payload.length === 1) throw new WsProtocolError('invalid close payload length 1');
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') };
}

const NEED_MORE = Symbol('needMoreBytes');
const CONSUMED = Symbol('consumedNoFrame');

/**
 * Incremental inbound frame decoder.
 *
 *   const dec = new FrameDecoder({ requireMask: true }); // server side
 *   for (const frame of dec.feed(chunk)) { ... }
 *
 * frame = { opcode, fin, payload: Buffer }
 * Control frames are emitted immediately (fin always true). Fragmented text/
 * binary messages are reassembled and emitted as a single frame when the
 * terminating continuation (fin=1) arrives.
 *
 * Throws WsProtocolError on any RFC violation: RSV bits, unknown opcode,
 * masking/opcode mismatches, oversize frames, control-frame violations,
 * orphan continuations.
 */
class FrameDecoder {
  constructor({ requireMask = true } = {}) {
    this.requireMask = requireMask;
    this.buf = Buffer.alloc(0);
    this.fragment = null; // { opcode, chunks: [Buffer] }
  }

  feed(chunk) {
    if (chunk && chunk.length > 0) {
      this.buf =
        this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    }
    const frames = [];
    for (;;) {
      const r = this._parseOne();
      if (r === NEED_MORE) break;
      if (r === CONSUMED) continue;
      frames.push(r);
    }
    return frames;
  }

  _parseOne() {
    const buf = this.buf;
    if (buf.length < 2) return NEED_MORE;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    if (rsv !== 0) throw new WsProtocolError('RSV bits must be zero');
    const opcode = b0 & 0x0f;
    if (!OPCODES.has(opcode)) throw new WsProtocolError(`invalid opcode ${opcode}`);
    const masked = (b1 & 0x80) !== 0;
    if (masked !== this.requireMask) {
      throw new WsProtocolError(
        masked ? 'unexpected masked inbound frame' : 'client frames must be masked'
      );
    }
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return NEED_MORE;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return NEED_MORE;
      const hi = buf.readUInt32BE(2);
      const lo = buf.readUInt32BE(6);
      if (hi > 0x200000) throw new WsProtocolError('frame length exceeds JS safe range');
      len = hi * 4294967296 + lo;
      off = 10;
    }
    const isControl = opcode >= 0x8;
    if (isControl && (!fin || len > MAX_CONTROL_PAYLOAD)) {
      throw new WsProtocolError('invalid control frame');
    }
    if (len > MAX_FRAME_LEN) throw new WsProtocolError(`frame too large: ${len}`);
    let maskKey = null;
    if (masked) {
      if (buf.length < off + 4) return NEED_MORE;
      maskKey = buf.subarray(off, off + 4);
      off += 4;
    }
    if (buf.length < off + len) return NEED_MORE;
    let payload = buf.subarray(off, off + len);
    this.buf = buf.subarray(off + len);
    if (masked) payload = xorMask(payload, maskKey);

    if (isControl) return { opcode, fin: true, payload };

    if (opcode === OP.CONTINUATION) {
      if (!this.fragment) throw new WsProtocolError('continuation frame without a started message');
      this.fragment.chunks.push(payload);
      if (!fin) return CONSUMED;
      const f = this.fragment;
      this.fragment = null;
      return { opcode: f.opcode, fin: true, payload: Buffer.concat(f.chunks) };
    }
    if (this.fragment) {
      throw new WsProtocolError('new data frame while a fragmented message is in progress');
    }
    if (!fin) {
      this.fragment = { opcode, chunks: [payload] };
      return CONSUMED;
    }
    return { opcode, fin: true, payload };
  }
}

// ---------------------------------------------------------------------------
// Outbound WSS client (header-capable replacement for global WebSocket)
// ---------------------------------------------------------------------------

/**
 * Connect an outbound WebSocket with full header control (e.g. xi-api-key).
 *
 *   const ws = connectOutbound({ url, headers: { 'xi-api-key': KEY } });
 *   ws.binaryType = 'arraybuffer';
 *   ws.onopen  = () => ...
 *   ws.onmessage = (ev) => ...   // ev.data: string | ArrayBuffer
 *   ws.onclose = (ev) => ...     // { code, reason, wasClean }
 *   ws.onerror = (ev) => ...
 *   ws.send(str | Uint8Array | ArrayBuffer);
 *   ws.close(code, reason);      // graceful close handshake
 *   ws.abort();                  // immediate teardown, no frames
 *
 * Returns a plain object with the same surface as the classic browser
 * WebSocket so callers (stt.js / tts.js) are testable with fakes.
 */
function connectOutbound({ url, headers = {}, timeoutMs = 10000 }) {
  const u = new URL(url);
  const isTls = u.protocol === 'wss:';
  const key = crypto.randomBytes(16).toString('base64');
  // The handshake request is sent via transport.request's `headers` option
  // below (same `key`, so the accept check matches). NEVER also write a raw
  // request head into the body: that pipelines a phantom second GET with a
  // different Sec-WebSocket-Key and desyncs the server mid-stream (observed
  // as local TLS "bad record mac" once WS frames flowed). buildClientRequest
  // remains exported for offline handshake tests only.

  const client = {
    readyState: 0, // CONNECTING
    binaryType: 'arraybuffer',
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    _socket: null,
    _remoteClosed: false,
    _closeHandled: false,
    _aborted: false,
    _decoder: null,
    _pending: [],
    _timer: null,
    _emitClose(code, reason, wasClean) {
      if (this._closeHandled) return;
      this._closeHandled = true;
      this.readyState = 3; // CLOSED
      if (this.onclose) this.onclose({ code, reason, wasClean });
    },
    send(data) {
      if (this.readyState > 1) throw new Error('WebSocket is not open');
      if (!this._socket || this._socket.destroyed) {
        this._pending.push(data);
        return;
      }
      // Client→server frames MUST be masked (RFC 6455 §5.1/§5.3).
      const frame = typeof data === 'string' ? encodeText(data, { mask: true }) : encodeBinary(data, { mask: true });
      this._socket.write(frame);
    },
    close(code, reason) {
      if (this.readyState === 2 || this.readyState === 3) return;
      this.readyState = 2; // CLOSING
      if (!this._socket || this._socket.destroyed) {
        this._emitClose(typeof code === 'number' ? code : 1006, reason || '', false);
        return;
      }
      try {
        this._socket.write(encodeClose(typeof code === 'number' ? code : 1000, reason || '', { mask: true }));
      } catch (_) {
        /* socket already dead; teardown below */
      }
      // Give the peer a moment to echo the close, then force teardown.
      this._timer = setTimeout(() => this.abort(), 2000);
      this._timer.unref?.();
    },
    abort() {
      this._aborted = true;
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      if (this._socket) {
        if (!this._socket.destroyed) this._socket.destroy();
      }
      this._emitClose(1006, '', false);
    },
  };

  const transport = isTls ? https : http;
  // node:http(s).request rejects non-http(s) protocol URLs — hand it a scheme-
  // normalized clone (wss:→https:, ws:→http:); path/host/auth are unchanged.
  const reqUrl = new URL(url);
  reqUrl.protocol = isTls ? 'https:' : 'http:';
  const req = transport.request(
    reqUrl,
    {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...headers,
      },
      servername: isTls ? u.hostname : undefined,
      rejectUnauthorized: true,
    },
    (res) => {
      // Server answered with a normal HTTP response instead of upgrading.
      const status = res.statusCode || 0;
      res.resume();
      const err = new Error(`upgrade rejected with HTTP ${status}`);
      err.status = status;
      client._fail(err);
    }
  );

  req.on('upgrade', (res, socket, head) => {
    if (client._aborted) {
      socket.destroy();
      return;
    }
    const status = res.statusCode || 0;
    if (status !== 101) {
      const err = new Error(`upgrade rejected with HTTP ${status}`);
      err.status = status;
      socket.destroy();
      client._fail(err);
      return;
    }
    if ((res.headers['sec-websocket-accept'] || '') !== computeAccept(key)) {
      const err = new WsProtocolError('Sec-WebSocket-Accept mismatch');
      socket.destroy();
      client._protoError(err);
      return;
    }
    clearTimeout(client._timer);
    client._socket = socket;
    client._decoder = new FrameDecoder({ requireMask: false });
    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = client._decoder.feed(chunk);
      } catch (err) {
        client._protoError(err);
        return;
      }
      for (const frame of frames) client._onFrame(frame);
    });
    socket.on('error', (err) => client._fail(err));
    socket.on('close', () => {
      client._socket = null;
      const code = client._remoteCloseCode != null ? client._remoteCloseCode : 1006;
      client._emitClose(code, client._remoteCloseReason || '', code === 1000);
    });
    socket.on('end', () => {
      /* close event follows */
    });
    if (head && head.length) {
      try {
        for (const frame of client._decoder.feed(head)) client._onFrame(frame);
      } catch (err) {
        client._protoError(err);
        return;
      }
    }
    client.readyState = 1; // OPEN
    for (const data of client._pending) {
      try {
        client.send(data);
      } catch (_) {
        /* ignored */
      }
    }
    client._pending = [];
    if (client.onopen) client.onopen({});
  });

  req.on('error', (err) => client._fail(err));

  client._fail = (err) => {
    if (client._closeHandled) return;
    if (client.onerror) client.onerror({ error: err, message: err.message });
    client._emitClose(err && err.status ? err.status : 1006, err && err.message ? err.message : '', false);
  };

  client._protoError = (err) => {
    if (client.onerror) client.onerror({ error: err, message: err.message });
    client._emitClose(1002, err.message, false);
    if (client._socket && !client._socket.destroyed) client._socket.destroy();
  };

  client._onFrame = (frame) => {
    if (client._closeHandled) return;
    switch (frame.opcode) {
      case OP.TEXT: {
        const data = frame.payload.toString('utf8');
        if (client.onmessage) client.onmessage({ data, type: 'message' });
        break;
      }
      case OP.BINARY: {
        // Deliver as ArrayBuffer, like the browser API.
        const ab = new ArrayBuffer(frame.payload.length);
        new Uint8Array(ab).set(frame.payload);
        if (client.onmessage) client.onmessage({ data: ab, type: 'message' });
        break;
      }
      case OP.PING: {
        try {
          client._socket?.write(encodePong(frame.payload, { mask: true }));
        } catch (_) {
          /* ignore */
        }
        break;
      }
      case OP.PONG:
        break;
      case OP.CLOSE: {
        let code = 1000;
        let reason = '';
        try {
          ({ code, reason } = decodeClosePayload(frame.payload));
        } catch (err) {
          code = 1002;
          reason = err.message;
        }
        client._remoteCloseCode = code;
        client._remoteCloseReason = reason;
        try {
          client._socket?.write(encodeClose(code, '', { mask: true }));
        } catch (_) {
          /* ignore */
        }
        client._socket?.end();
        break;
      }
      default:
        break;
    }
  };

  client._timer = setTimeout(() => {
    const err = new Error(`connect timeout after ${timeoutMs}ms`);
    err.status = 0;
    req.destroy(err);
  }, timeoutMs);
  client._timer.unref?.();
  req.end();
  return client;
}

module.exports = {
  GUID,
  OP,
  OPCODES,
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
  connectOutbound,
};