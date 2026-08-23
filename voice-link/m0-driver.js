#!/usr/bin/env node
/**
 * m0-driver.js — LIVE end-to-end drill of the voice stack, no browser, no plugin.
 * Plays the HOST role over stdio (PROTOCOL §3) and the BROWSER role inside the
 * tunnel (PROTOCOL §1), against the real ElevenLabs cloud.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=sk_... [ELEVENLABS_VOICE_ID=...] node m0-driver.js <pcm16-16k-mono.raw> "transcript expectation"
 *
 * Steps: spawn entry.js → init → ready → socket.attach → WS upgrade bytes as first record →
 * expect 101 → masked text {hello}+{listen.start} → masked binary PCM chunks → expect
 * stt.committed → injected bare-JSON tts.speak → collect tts.audio b64 → write /tmp/m0-out.mp3
 * → stop. Prints per-event wall-clock deltas.
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('path');
const crypto = require('node:crypto');
const { makeMaskedFrame, TEXT, BINARY, CLOSE } = require('./test/helpers.js');

const MAGIC = Buffer.alloc(4); MAGIC.writeUInt32BE(0x0D510001, 0);
const CONN_IDX = 1;
const t0 = Date.now();
const dt = () => `+${Date.now() - t0}ms`;

function record(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.alloc(5);
  head.writeUInt32BE(0x0D510001, 0);
  head.writeUInt8(CONN_IDX, 4);
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, len, body]);
}

class Driver {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.events = [];
    this.waiters = [];
    this.audio = [];
    this.sawCommitted = null;
    this.ttsDone = false;
  }
  start() {
    this.child = spawn('node', [path.join(__dirname, 'entry.js')], {
      env: process.env, stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child.stdout.on('data', (d) => this.feed(d));
    this.child.on('exit', (c, s) => console.log(`[exit ${dt()}] code=${c} signal=${s}`));
    this.send(JSON.stringify({ type: 'init', proto: 1, logLevel: 'debug' }));
    return new Promise((res, rej) => {
      this.waiters.push({ pred: (e) => e.type === 'ready', resolve: res });
      setTimeout(() => rej(new Error('no ready in 10s')), 10000);
    });
  }
  send(lineOrBuf) { this.child.stdin.write(typeof lineOrBuf === 'string' ? lineOrBuf + '\n' : lineOrBuf); }
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length >= 1 && this.buf[0] === 0x7b /* '{' */) {
        const nl = this.buf.indexOf(0x0a);
        if (nl < 0) return;
        const line = this.buf.subarray(0, nl).toString('utf8').trim();
        this.buf = this.buf.subarray(nl + 1);
        if (!line) continue;
        try { this.onEvent(JSON.parse(line)); } catch (e) { console.log('[bad json]', line.slice(0, 120)); }
        continue;
      }
      if (this.buf.length < 9) return;
      if (this.buf.readUInt32BE(0) !== 0x0D510001) { this.buf = this.buf.subarray(1); continue; }
      const len = this.buf.readUInt32BE(5);
      if (this.buf.length < 9 + len) return;
      const payload = Buffer.from(this.buf.subarray(9, 9 + len));
      this.buf = this.buf.subarray(9 + len);
      this.onTunnelPayload(payload);
    }
  }
  onEvent(e) {
    if (e.type === 'ready') console.log(`[ready ${dt()}] pid=${e.pid}`);
    else if (e.type === 'socket.open') console.log(`[ws-open ${dt()}] handshake accepted`);
    else if (e.type === 'log') console.log(`[log ${dt()}]`, e.level, String(e.msg).slice(0, 160));
    else if (e.type !== 'stopped') console.log(`[${dt()}] ctrl`, JSON.stringify(e).slice(0, 160));
    this.dispatch(e);
  }
  // Helper→host records carry BROWSER-bound payloads: bare JSON text or framed WS bytes.
  onTunnelPayload(payload) {
    if (payload.length && payload[0] === 0x7b) {
      let e; try { e = JSON.parse(payload.toString('utf8')); } catch { return; }
      this.onBrowserJson(e); return;
    }
    // framed bytes: look at opcode of first frame (RFC6455: FIN/opcode byte)
    if (payload.length >= 2) {
      const op = payload[0] & 0x0f;
      if (op === 0x8) { console.log(`[ws-close ${dt()}]`); this.dispatch({ type: 'ws.close' }); }
      else if (op === 0x1 || op === 0x2) {
        // unmask server frame (server frames are unmasked; parse len)
        let off = 2, len = payload[1] & 0x7f;
        if (len === 126) { len = payload.readUInt16BE(2); off = 4; }
        else if (len === 127) { len = Number(payload.readBigUInt64BE(2)); off = 10; }
        try { this.onBrowserJson(JSON.parse(payload.subarray(off, off + len).toString('utf8'))); } catch {}
      }
    }
  }
  onBrowserJson(e) {
    if (e.type === 'stt.committed') { this.sawCommitted = e.text; console.log(`[COMMITTED ${dt()}] "${e.text}"`); }
    else if (e.type === 'stt.partial' && e.text) process.stdout.write(`  …partial ${dt()}: ${e.text}\n`);
    else if (e.type === 'tts.audio') { if (e.b64) this.audio.push(Buffer.from(e.b64, 'base64')); if (e.done) { this.ttsDone = true; console.log(`[tts done ${dt()}] bytes=${this.audio.reduce((n, b) => n + b.length, 0)}`); } }
    else if (e.type === 'tts.error' || e.type === 'stt.error') console.log(`[ERROR ${dt()}]`, JSON.stringify(e));
    else if (e.type !== 'pong') console.log(`[${dt()}] ws`, JSON.stringify(e).slice(0, 140));
    this.dispatch(e);
  }
  dispatch(e) {
    this.events.push(e);
    this.waiters = this.waiters.filter((w) => { if (w.pred(e)) { w.resolve(e); return false; } return true; });
  }
  waitFor(pred, ms, label) {
    const hit = this.events.find(pred); if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      this.waiters.push({ pred, resolve: res });
      setTimeout(() => rej(new Error('timeout: ' + label)), ms);
    });
  }
}

(async () => {
  const pcmPath = process.argv[2];
  const expected = process.argv[3] || '';
  if (!process.env.ELEVENLABS_API_KEY) { console.error('ELEVENLABS_API_KEY required'); process.exit(2); }
  const pcm = fs.readFileSync(pcmPath);
  console.log(`pcm ${(pcm.length / 1024).toFixed(0)}KiB (~${(pcm.length / 32000).toFixed(1)}s audio)`);

  const d = new Driver();
  await d.start();
  // Keep the helper heartbeat fed like the real browser UI does.
  const hb = setInterval(() => { try { d.send(record(makeMaskedFrame(TEXT, Buffer.from(JSON.stringify({ type: 'ping', ts: Date.now() }))))); } catch (_) {} }, 10000);

  // HOST role: attach a connection whose URL carries the one-time token.
  d.send(JSON.stringify({ type: 'socket.attach', connId: 'c1', url: '/__dsh-voice/ws?t=m0token' }));

  // BROWSER role: replay an upgrade request immediately — the helper emits
  // socket.open only after parsing these bytes (stdio order guarantees delivery).
  const key = crypto.randomBytes(16).toString('base64');
  const upgrade = [
    'GET /__dsh-voice/ws?t=m0token HTTP/1.1', 'Host: 127.0.0.1',
    'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13', '', '',
  ].join('\r\n');
  d.send(record(upgrade));
  await d.waitFor((e) => e.type === 'socket.open', 8000, 'socket.open');

  d.send(record(makeMaskedFrame(TEXT, Buffer.from(JSON.stringify({ type: 'hello', token: 'm0token', proto: 1 })))));
  await d.waitFor((e) => e.type === 'ready', 5000, 'browser ready');

  d.send(record(makeMaskedFrame(TEXT, Buffer.from(JSON.stringify({ type: 'listen.start', commit: 'manual' })))));
  // Real UIs wait for the FSM to reach 'listening' before streaming audio.
  await d.waitFor((e) => e.type === 'session.state' && e.state === 'listening', 15000, 'state=listening');
  const CHUNK = 32000; // 1s of 16k mono s16le
  for (let off = 0; off < pcm.length; off += CHUNK) {
    d.send(record(makeMaskedFrame(BINARY, pcm.subarray(off, Math.min(off + CHUNK, pcm.length)))));
    await new Promise((r) => setTimeout(r, 250)); // ~4x realtime feed
  }
  await new Promise((r) => setTimeout(r, 400)); // tail silence for endpointing
  d.send(record(makeMaskedFrame(TEXT, Buffer.from(JSON.stringify({ type: 'listen.stop' })))));

  await d.waitFor((e) => e.type === 'stt.committed', 30000, 'stt.committed');
  if (expected) {
    const got = (d.sawCommitted || '').toLowerCase().replace(/[^a-z ]/g, '');
    const want = expected.toLowerCase().replace(/[^a-z ]/g, '');
    console.log(got.includes(want.split(' ').slice(0, 4).join(' ')) ? 'TRANSCRIPT MATCH ✓' : `TRANSCRIPT MISMATCH — wanted "${expected}"`);
  }

  // Injected host→helper control frames ride the tunnel as bare-JSON records
  // (PROTOCOL §3 / INTEGRATION.md §4), not as stdin control lines.
  d.send(record(JSON.stringify({ type: 'tts.speak', id: 'q1', text: 'Thread started. I will report back when it finishes.' })));
  await d.waitFor((e) => (e.type === 'tts.audio' && e.done) || e.type === 'tts.error', 60000, 'tts terminal');
  fs.writeFileSync('/tmp/m0-out.mp3', Buffer.concat(d.audio));

  d.send(JSON.stringify({ type: 'stop' }));
  await d.waitFor((e) => e.type === 'stopped', 5000, 'stopped');
  console.log('M0 DRIVER COMPLETE');
  clearInterval(hb);
  process.exit(0);
})().catch((e) => { console.error('DRIVER FAIL:', e.message); process.exit(1); });
