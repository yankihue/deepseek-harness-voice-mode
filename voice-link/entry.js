'use strict';

/**
 * entry.js — voice-link helper process entry point.
 *
 * Boot sequence (PROTOCOL.md §3):
 *   1. read the first stdin control line: {"type":"init","proto":1,"logLevel":"info"}
 *   2. emit {"type":"ready","proto":1,"pid":<pid>} on stdout
 *   3. serve socket.attach / socket.detach + byte-tunnel records
 *   4. clean shutdown on {"type":"stop"} or stdin close: emit {"type":"stopped"}
 *
 * Environment:
 *   ELEVENLABS_API_KEY   — required for STT/TTS; missing ⇒ immediate
 *                          stt_auth / tts_auth errors (never reaches network)
 *   ELEVENLABS_VOICE_ID  — TTS voice id (the protocol defines no channel for it)
 *   ELEVENLABS_TTS_MODEL — default eleven_flash_v2_5
 *   ELEVENLABS_STT_MODEL — default scribe_v2_realtime
 *
 * stdout carries control JSON lines + byte-tunnel records (tunnel.js).
 * stderr carries free-form diagnostics. The API key is never logged or
 * persisted.
 *
 * Run: node entry.js   (stdio pipes provided by the host)
 * Tests: node --test test/
 *
 * Zero npm dependencies. Node >= 22.
 */

const { TunnelParser, TunnelWriter, TunnelError } = require('./tunnel.js');
const { Bridge } = require('./bridge.js');
const { connectOutbound } = require('./wsio.js');

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// ---------------------------------------------------------------- defaults

/** Real outbound WS factory (node:https upgrade, header-capable). */
function defaultConnectStt(url, opts) {
  return connectOutbound({ url, headers: opts?.headers || {}, timeoutMs: 10000 });
}

/** Real outbound WS factory for TTS (auth travels in the first message). */
function defaultConnectTts(url, opts = {}) {
  return connectOutbound({ url, timeoutMs: 10000, ...opts });
}

function defaultEnv(env) {
  return {
    apiKey: env.ELEVENLABS_API_KEY || '',
    voiceId: env.ELEVENLABS_VOICE_ID || '',
    ttsModel: env.ELEVENLABS_TTS_MODEL || undefined,
    sttModel: env.ELEVENLABS_STT_MODEL || undefined,
  };
}

// -------------------------------------------------------------------- run

/**
 * Run the helper. Injectable streams/factories make the whole lifecycle
 * testable offline.
 *
 * @param {object} [io]
 * @param {AsyncIterable<Buffer>} [io.stdin]      default process.stdin
 * @param {WritableLike} [io.stdout]              .write(buf[, cb])
 * @param {WritableLike} [io.stderr]              diagnostics
 * @param {Function} [io.connectStt]              (url, opts) => WebSocketLike
 * @param {Function} [io.connectTts]              (url, opts) => WebSocketLike
 * @param {object} [io.env]                       env vars (default process.env)
 * @param {Function} [io.exit]                    (code) => void; default flushes
 *                                                stdout then process.exit
 * @returns {Promise<void>} resolves when the helper has stopped
 */
async function run({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr,
  connectStt = defaultConnectStt,
  connectTts = defaultConnectTts,
  env = process.env,
  exit,
} = {}) {
  const cfg = defaultEnv(env);
  const exitFn =
    exit ||
    ((code) => {
      try {
        stdout.write(Buffer.alloc(0), () => process.exit(code));
      } catch (_) {
        process.exit(code);
      }
    });

  const writer = new TunnelWriter((buf) => {
    stdout.write(buf);
  });

  let logLevel = 'info';
  const logFn = (level, msg) => {
    if ((LOG_LEVELS[level] || 0) < (LOG_LEVELS[logLevel] || 0)) return;
    try {
      stderr?.write(`[voice-link] ${level}: ${msg}\n`);
    } catch (_) {
      /* ignore */
    }
    if (level === 'warn' || level === 'error') {
      try {
        writer.json({ type: 'log', level, msg });
      } catch (_) {
        /* ignore */
      }
    }
  };

  const bridge = new Bridge({
    apiKey: cfg.apiKey,
    voiceConfig: {
      voiceId: cfg.voiceId,
      ttsModel: cfg.ttsModel,
      sttModel: cfg.sttModel,
    },
    connectStt,
    connectTts,
    log: logFn,
  });

  bridge.onSocketBytes = (connId, bytes) => {
    const idx = bridge.connIndex(connId);
    if (idx === -1) {
      logFn('warn', `socket bytes for unknown conn '${connId}'`);
      return;
    }
    writer.record(idx, bytes);
  };
  bridge.onControl = (obj) => writer.json(obj);

  let stopping = false;
  const finalize = (reason) => {
    if (stopping) return;
    stopping = true;
    logFn('info', `stopping: ${reason}`);
    bridge.stop(); // tear down every socket/timer/session, silently
    try {
      writer.json({ type: 'stopped' });
    } catch (_) {
      /* ignore */
    }
    exitFn(0);
  };

  const parser = new TunnelParser();
  let gotInit = false;

  // Returns true when a stop was requested (caller must stop consuming stdin).
  const handleEvent = (ev) => {
    if (ev.kind === 'record') {
      bridge.feedRecord(ev.connIdx, ev.payload);
      return false;
    }
    const obj = ev.obj;
    if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') {
      throw new TunnelError('control line is not an object with a type');
    }
    if (!gotInit) {
      if (obj.type !== 'init') {
        throw new TunnelError(`first message must be init, got '${obj.type}'`);
      }
      if (obj.proto !== 1) {
        throw new TunnelError(`unsupported protocol ${obj.proto} (expected 1)`);
      }
      gotInit = true;
      if (typeof obj.logLevel === 'string' && LOG_LEVELS[obj.logLevel] !== undefined) {
        logLevel = obj.logLevel;
      }
      writer.json({ type: 'ready', proto: 1, pid: process.pid });
      return false;
    }
    switch (obj.type) {
      case 'socket.attach': {
        if (typeof obj.connId !== 'string' || !obj.connId || typeof obj.url !== 'string') {
          throw new TunnelError('malformed socket.attach');
        }
        bridge.attach(obj.connId, obj.url);
        return false;
      }
      case 'socket.detach':
        bridge.detach(obj.connId);
        return false;
      case 'stop':
        finalize('host requested stop');
        return true;
      default:
        logFn('debug', `unknown control type '${obj.type}' ignored`);
        return false;
    }
  };

  try {
    for await (const chunk of stdin) {
      let events;
      try {
        events = parser.feed(chunk);
      } catch (err) {
        if (err instanceof TunnelError) {
          logFn('error', `stdin framing error: ${err.message}`);
          finalize(`stdin framing error: ${err.message}`);
          return;
        }
        throw err;
      }
      for (const ev of events) {
        let stopNow = false;
        try {
          stopNow = handleEvent(ev);
        } catch (err) {
          logFn('error', `${err.name || 'error'}: ${err.message}`);
          finalize(`control error: ${err.message}`);
          return;
        }
        if (stopNow) return; // 'stop' processed; exit handled by finalize
      }
    }
  } catch (err) {
    logFn('error', `stdin stream error: ${err.message}`);
    finalize(`stdin stream error: ${err.message}`);
    return;
  }

  if (!gotInit) {
    logFn('error', 'stdin closed before init');
    finalize('stdin closed before init');
    return;
  }
  finalize('stdin closed');
}

// Defensive: the host normally sends 'stop', but a hard kill should still
// release sockets/timers rather than hang.
{
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    try {
      process.stdout.write('{"type":"stopped"}\n');
    } catch (_) {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

if (require.main === module) {
  run({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr })
    .then(() => {})
    .catch((err) => {
      console.error(`[voice-link] fatal: ${err && err.stack ? err.stack : err}`);
      try {
        process.stdout.write('{"type":"stopped"}\n');
      } catch (_) {
        /* ignore */
      }
      process.exit(1);
    });
}

module.exports = { run, defaultConnectStt, defaultConnectTts, defaultEnv };