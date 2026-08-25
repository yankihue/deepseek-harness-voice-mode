'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const artifacts = ['packages/orchestrator/host.js', 'packages/orchestrator/plugin.cjs'];

function routerCore(relativePath) {
  const code = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const startMarker = '/* ROUTER_CORE_START';
  const endMarker = '/* ROUTER_CORE_END */';
  const start = code.indexOf(startMarker);
  const bodyStart = code.indexOf('*/', start) + 2;
  const end = code.indexOf(endMarker, bodyStart);
  assert.notEqual(start, -1, `${relativePath}: missing router start marker`);
  assert.notEqual(end, -1, `${relativePath}: missing router end marker`);
  return code.slice(bodyStart, end).trim();
}

function loadClassifier(relativePath) {
  const sandbox = {
    isNonEmptyString(value) {
      return typeof value === 'string' && value.trim().length > 0;
    },
  };
  vm.runInNewContext(`${routerCore(relativePath)}\nthis.route = deterministicRoute;`, sandbox);
  return sandbox.route;
}

test('shipped host artifacts contain identical deterministic routing logic', () => {
  assert.equal(routerCore(artifacts[0]), routerCore(artifacts[1]));
});

for (const artifact of artifacts) {
  test(`${artifact}: deterministic lifecycle commands`, () => {
    const route = loadClassifier(artifact);

    assert.deepEqual(
      JSON.parse(JSON.stringify(route('Create a thread called repo audit to check the connected GitHub repository.'))),
      {
        verb: 'create_thread',
        threadTitle: 'repo audit',
        text: 'Create a thread called repo audit to check the connected GitHub repository.',
      },
    );
    assert.equal(route('new task for dependency cleanup').verb, 'create_thread');
    assert.equal(route("What's running?").verb, 'status');
    assert.equal(route("Can you tell me, um, when there's progress?").verb, 'status');
    assert.equal(route('Can you tell me when there’s progress?').verb, 'status');
    assert.equal(route('Any progress?').verb, 'status');
    assert.equal(route('stop the current thread').verb, 'interrupt');
    assert.equal(route('cancel task called repo audit').threadTitle, 'repo audit');
  });

  test(`${artifact}: ordinary requests remain available to the LLM router`, () => {
    const route = loadClassifier(artifact);
    assert.equal(route('Can you create a file with the results?'), null);
    assert.equal(route('How do I create a thread in JavaScript?'), null);
    assert.equal(route('Stop talking about tests and explain the code.'), null);
    assert.equal(route('Tell me a story about progress.'), null);
    assert.equal(route("I will tell you when there's progress."), null);
    assert.equal(route('Check the connected GitHub repository.'), null);
  });
}

test('LLM fallback uses the bounded low-reasoning router contract', () => {
  for (const artifact of artifacts) {
    const code = fs.readFileSync(path.join(root, artifact), 'utf8');
    assert.match(code, /var ROUTER_TIMEOUT_MS = 8000;/);
    assert.match(code, /var ROUTER_REASONING_EFFORT = 'low';/);
    assert.match(code, /purpose: 'voice-intent-router'/);
    assert.match(code, /reasoningEffort: ROUTER_REASONING_EFFORT/);
    assert.match(code, /reasoningEffort: model && model\.provider \? ROUTER_REASONING_EFFORT : null/);
    assert.match(code, /'timeout' : 'invalid_json'/);
    assert.match(code, /'route_current', 'model_error'/);
    assert.match(code, /return \{ kind: 'error' \};/);
    assert.doesNotMatch(code, /Working on it\./);
  }
});

test('voice-created agents pin a provider-supported reasoning effort', () => {
  for (const artifact of artifacts) {
    const code = fs.readFileSync(path.join(root, artifact), 'utf8');
    assert.match(code, /var VOICE_AGENT_REASONING_EFFORT = 'low'/);
    assert.match(code, /agentCtx\.on\('agent\/request'/);
    assert.match(code, /reasoningEffort: VOICE_AGENT_REASONING_EFFORT/);
  }
});
