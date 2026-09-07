// The four states a silent bridge can be in, and why telling them apart matters:
// only one of them is worth retrying, one needs a restart, one needs waiting,
// and one means PixInsight was never started.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { watcherStatus } from '../agents/ops/bridge.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixinsight-bridge-'));

function heartbeat(fields = {}) {
  const p = path.join(tmp, `hb-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({
    version: '0.2.0',
    engine: 'v8',
    coreVersion: '1.9.4.0',
    state: 'idle',
    currentCommand: null,
    commandsProcessed: 12,
    timestamp: new Date().toISOString(),
    ...fields,
  }));
  return p;
}

const missing = path.join(tmp, 'no-such-heartbeat.json');

test('no heartbeat and no process means PixInsight was never started', () => {
  const s = watcherStatus({ heartbeatPath: missing, running: false });
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'not-running');
});

test('no heartbeat while the process runs means the watcher never loaded', () => {
  const s = watcherStatus({ heartbeatPath: missing, running: true });
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'no-heartbeat');
  // This is the case a PJSR error produces, and the one people cannot diagnose
  // on their own, so the recovery command has to be in the message.
  assert.match(s.detail, /pi-launch/);
});

test('a heartbeat with no process means PixInsight crashed', () => {
  const s = watcherStatus({ heartbeatPath: heartbeat(), running: false });
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'crashed');
});

test('a crash during a command names the command it died in', () => {
  const p = heartbeat({ state: 'busy', currentCommand: { id: 'abc', tool: 'run_bxt' } });
  const s = watcherStatus({ heartbeatPath: p, running: false });
  assert.equal(s.reason, 'crashed');
  assert.match(s.detail, /run_bxt/);
});

test('a fresh idle heartbeat is healthy', () => {
  const s = watcherStatus({ heartbeatPath: heartbeat(), running: true });
  assert.equal(s.ok, true);
  assert.equal(s.reason, 'idle');
});

test('an old idle heartbeat means the loop stopped', () => {
  const p = heartbeat({ timestamp: new Date(Date.now() - 60_000).toISOString() });
  const s = watcherStatus({ heartbeatPath: p, running: true });
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'stale');
});

test('an old BUSY heartbeat is a long process, not a hang', () => {
  // The watcher is blocked inside executeOn and cannot refresh anything, so a
  // 20-minute BlurXTerminator run looks exactly like a stopped loop from the
  // timestamp alone. Reading it as a hang would abort every long process.
  const p = heartbeat({
    state: 'busy',
    currentCommand: { id: 'abc', tool: 'run_bxt' },
    timestamp: new Date(Date.now() - 20 * 60_000).toISOString(),
  });
  const s = watcherStatus({ heartbeatPath: p, running: true });
  assert.equal(s.ok, true);
  assert.equal(s.reason, 'busy');
  assert.match(s.detail, /run_bxt/);
});

test('a malformed heartbeat is treated as no heartbeat', () => {
  const p = path.join(tmp, 'broken.json');
  fs.writeFileSync(p, '{ not json');
  const s = watcherStatus({ heartbeatPath: p, running: true });
  assert.equal(s.reason, 'no-heartbeat');
});
