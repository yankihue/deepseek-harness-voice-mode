'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('host source and shipped wrapper preserve initial thread delivery', () => {
  for (const file of ['packages/orchestrator/host.js', 'packages/orchestrator/plugin.cjs']) {
    const code = read(file);
    const createStart = code.indexOf('ThreadManager.prototype.create =');
    const messageStart = code.indexOf('ThreadManager.prototype.message =', createStart);
    assert.notEqual(createStart, -1, `${file}: missing create method`);
    assert.notEqual(messageStart, -1, `${file}: missing message method`);

    const createMethod = code.slice(createStart, messageStart);
    assert.match(createMethod, /var wake = self\.makeUserMessage\(text\);/);
    assert.doesNotMatch(createMethod, /var wake = this\.makeUserMessage\(text\);/);
  }
});

test('HTTP RPC requires same-origin JSON requests in both host artifacts', () => {
  for (const file of ['packages/orchestrator/host.js', 'packages/orchestrator/plugin.cjs']) {
    const code = read(file);
    assert.match(code, /code: 'origin_denied'/);
    assert.match(code, /code: 'loopback_required'/);
    assert.match(code, /code: 'loopback_host_required'/);
    assert.match(code, /function isLoopbackHost\(value\)/);
    assert.match(code, /if \(!origin \|\|/);
    assert.match(code, /fetchSite !== 'same-origin'/);
    assert.match(code, /contentType\.indexOf\('application\/json'\) !== 0/);
  }
});

test('browser bundle loads and exports the Cordis client face', () => {
  let registration;
  const oldWindow = global.window;
  global.window = { __ModuleLoader__: { load(value) { registration = value; } } };
  try {
    const filename = path.join(root, 'packages/client/lib/client.js');
    delete require.cache[filename];
    require(filename);
    assert.equal(registration.id, 'deepseek-voice-mode-ui');
    const exported = registration.factory((name) => {
      if (name === 'react') return {};
      throw new Error(`unexpected client dependency: ${name}`);
    });
    assert.equal(typeof exported.apply, 'function');
    assert.deepEqual(exported.inject, ['slots', 'timer']);
  } finally {
    global.window = oldWindow;
  }
});

test('TTS playback suppresses microphone input and remains cancellable until playback ends', () => {
  const code = read('packages/client/lib/client.js');
  assert.match(code, /case 'tts\.start':\s*mic\.suppress = true;/);
  assert.match(code, /function finishPlayback\(id\)/);
  assert.match(code, /src\.onended = function \(\) \{[\s\S]*?finishPlayback\(id\);/);
  assert.doesNotMatch(code, /chain\.then\(function \(\) \{\s*delete play\.utts\[id\];/);
  assert.match(code, /if \(!b64 && !done\) return;/);
  assert.doesNotMatch(code, /if \(!b64\) \{ if \(done\) cancelPlayback\(id\); return; \}/);
  assert.match(code, /resetPlayback\(\);/);
  assert.match(code, /if \(play\.utts\[id\] !== u\) return;/);
});

test('helper path is derived from the installed plugin in both host artifacts', () => {
  for (const file of ['packages/orchestrator/host.js', 'packages/orchestrator/plugin.cjs']) {
    const code = read(file);
    assert.match(code, /return __dirname \+ '\/\.\.\/\.\.\/voice-link\/entry\.js';/);
    assert.doesNotMatch(code, /\/Users\/yanki\/Desktop\/personal\/seeker/);
    assert.doesNotMatch(code, /helperPath: \{ type: 'string'/);
  }
});
