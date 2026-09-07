#!/usr/bin/env node
// Stop the watcher without killing PixInsight, and say what actually happened.
//
// The watcher looks for a sentinel file. If it does not stop, the running
// instance predates the latch fix — a watcher built before that read the
// sentinel, deleted it, and kept going, so the only way to stop those is
// Ctrl+F11 in PixInsight or terminating the application.
//
// Usage: node scripts/pi-stop.mjs [--force]     (--force terminates PixInsight)

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { watcherStatus, isPixInsightRunning } from '../agents/ops/bridge.mjs';
import { BRIDGE_DIR, PI_BIN } from '../agents/ops/pixinsight.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
const force = process.argv.includes('--force');

if (!isPixInsightRunning()) {
  console.log('PixInsight is not running.');
  process.exit(0);
}

const before = watcherStatus();
if (!before.ok && before.reason === 'no-heartbeat') {
  console.log('PixInsight is running but no watcher is loaded — nothing to stop.');
  process.exit(0);
}

fs.writeFileSync(path.join(BRIDGE_DIR, 'shutdown'), '');
console.log('Shutdown signal written. Waiting for the watcher to notice…');

// The loop only checks between commands, so a watcher part-way through a
// twenty-minute BlurXTerminator run will not stop until that finishes. Waiting
// is the right behaviour — interrupting mid-process would leave the image in an
// unknown state — but it must be reported as waiting, not as a failure.
const IDLE_PATIENCE_MS = 10_000;
const startedAt = Date.now();
let announcedBusy = false;

for (;;) {
  await delay(500);

  if (!fs.existsSync(path.join(BRIDGE_DIR, 'watcher.json'))) {
    console.log('Watcher stopped. PixInsight is still running with its images open.');
    process.exit(0);
  }

  const now = watcherStatus();
  if (now.reason === 'busy') {
    if (!announcedBusy) {
      announcedBusy = true;
      console.log(
        `The watcher is busy running ${now.heartbeat?.currentCommand?.tool ?? 'a command'}. ` +
        `It will stop when that finishes — waiting rather than interrupting it.`);
    }
    continue;
  }

  // Idle, and still not gone. That is the failure worth reporting.
  if (Date.now() - startedAt > IDLE_PATIENCE_MS) break;
}

try { fs.unlinkSync(path.join(BRIDGE_DIR, 'shutdown')); } catch {}

if (!force) {
  console.error(
    '\nThe watcher is idle and did not stop.\n' +
    'A watcher started before the shutdown latch was fixed cannot be stopped by the sentinel:\n' +
    'its inner yield loop consumed the file and kept going. Either press Ctrl+F11 with\n' +
    'PixInsight\'s Process Console focused, or re-run with --force to terminate PixInsight\n' +
    '(open images are lost; anything already saved to disk is not).');
  process.exit(1);
}

console.log('Terminating PixInsight…');
try { execFileSync(PI_BIN, ['--terminate=1'], { timeout: 30_000, stdio: 'ignore' }); } catch {}
await delay(3000);
console.log(isPixInsightRunning() ? 'PixInsight is still up; kill it by hand.' : 'PixInsight terminated.');
