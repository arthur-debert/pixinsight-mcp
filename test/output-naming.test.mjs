// Every run used to write NGC_2808_giga.xisf, so every run silently replaced
// the last. Three runs in one morning left one file and no way to tell which
// run made it — the only surviving earlier version existed because someone had
// copied it by hand before the next run started.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

import { runStampedOutputPaths } from '../agents/artifact-store.mjs';

const OUT = '/Volumes/T7/astrophotography/targets/ngc2808/agentic';

test('two runs of the same target do not collide', () => {
  const a = runStampedOutputPaths(OUT, 'NGC_2808', 'run_2026-09-07_675ddd6a');
  const b = runStampedOutputPaths(OUT, 'NGC_2808', 'run_2026-09-07_54611864');
  assert.notEqual(a.xisf, b.xisf);
  assert.notEqual(a.png, b.png);
});

test('the filename names the run that can explain it', () => {
  const { xisf } = runStampedOutputPaths(OUT, 'NGC_2808', 'run_2026-09-07_675ddd6a');
  const name = path.basename(xisf);
  // Someone holding this file must be able to find ~/.pixinsight-mcp/runs/run_<...>
  assert.ok(name.includes('675ddd6a'), name);
  assert.ok(name.includes('2026-09-07'), name);
  assert.ok(!name.includes('run_'), `the "run_" prefix is noise in a filename: ${name}`);
});

test('names sort chronologically', () => {
  const ids = ['run_2026-09-05_aaaaaaaa', 'run_2026-09-07_bbbbbbbb', 'run_2026-10-01_cccccccc'];
  const names = ids.map(id => path.basename(runStampedOutputPaths(OUT, 'M13', id).xisf));
  assert.deepEqual([...names].sort(), names, 'ls should show the newest last');
});

test('the latest pointer is stable across runs', () => {
  // It is a text file rather than a symlink: the data drive is exFAT.
  const a = runStampedOutputPaths(OUT, 'NGC_2808', 'run_2026-09-07_675ddd6a');
  const b = runStampedOutputPaths(OUT, 'NGC_2808', 'run_2026-09-08_11111111');
  assert.equal(a.latest, b.latest);
  assert.ok(a.latest.endsWith('.txt'));
});

test('different targets stay separate', () => {
  const a = runStampedOutputPaths(OUT, 'NGC_2808', 'run_2026-09-07_675ddd6a');
  const b = runStampedOutputPaths(OUT, 'M13', 'run_2026-09-07_675ddd6a');
  assert.notEqual(a.xisf, b.xisf);
  assert.notEqual(a.latest, b.latest);
});

test('everything lands in the configured output directory', () => {
  const p = runStampedOutputPaths(OUT, 'NGC_2808', 'run_2026-09-07_675ddd6a');
  for (const f of [p.xisf, p.png, p.latest]) {
    assert.equal(path.dirname(f), OUT);
  }
});
