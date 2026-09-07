#!/usr/bin/env node
// Start PixInsight with the MCP watcher loaded, and do not return until the
// watcher has actually answered.
//
// Two failure modes make the naive `PixInsight -r=watcher.js &` unusable:
//
//   1. In windowed mode a PJSR compile error opens a modal dialog. Nothing on
//      the Node side can dismiss it, the process sits at 0% CPU forever, and
//      every bridge call times out with no explanation. `--automation-mode`
//      routes those errors to the console instead of a dialog box.
//   2. A script that fails to load looks exactly like one that loaded fine:
//      PixInsight is running either way. The watcher's heartbeat file settles
//      that, and this launcher waits on it.
//
// Usage:
//   node scripts/pi-launch.mjs [--slot N] [--timeout SECONDS] [--restart] [--windowed]

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFileSync } from 'child_process';
import { watcherStatus, isPixInsightRunning } from '../agents/ops/bridge.mjs';

const HOME = os.homedir();
const BRIDGE_DIR = path.join(HOME, '.pixinsight-mcp/bridge');
const HEARTBEAT = path.join(BRIDGE_DIR, 'watcher.json');
const PI_BIN = '/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight';
const WATCHER = path.resolve(import.meta.dirname, '../pjsr/pixinsight-mcp-watcher.js');

function parseArgs(argv) {
  const opts = { slot: 1, timeout: 120, restart: false, windowed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slot') opts.slot = parseInt(argv[++i], 10);
    else if (a === '--timeout') opts.timeout = parseInt(argv[++i], 10);
    else if (a === '--restart') opts.restart = true;
    else if (a === '--windowed') opts.windowed = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

// Liveness classification lives in the bridge, next to the code that has to act
// on it. Re-exported here so the launcher and its callers share one definition.
export { watcherStatus, isPixInsightRunning };

// Named delay, not sleep: PJSR has a deprecated global by that name and the
// lint should keep flagging any call to it.
const delay = ms => new Promise(r => setTimeout(r, ms));

async function terminateRunning(slot) {
  try {
    execFileSync(PI_BIN, [`--terminate=${slot}`], { timeout: 30_000, stdio: 'ignore' });
  } catch { /* no instance in that slot */ }
  for (let i = 0; i < 20 && isPixInsightRunning(); i++) await delay(500);
  try { execFileSync('/usr/bin/pkill', ['-f', 'PixInsight.app/Contents/MacOS/PixInsight'], { stdio: 'ignore' }); } catch {}
  await delay(2000);
}

export async function launch(opts = {}) {
  const { slot = 1, timeout = 120, restart = false, windowed = false, log = console.log } = opts;

  if (!fs.existsSync(PI_BIN)) throw new Error(`PixInsight not found at ${PI_BIN}`);
  if (!fs.existsSync(WATCHER)) throw new Error(`Watcher script not found at ${WATCHER}`);

  const existing = watcherStatus();
  if (existing.ok && !restart) {
    log(`Watcher already alive: ${existing.detail}`);
    return existing;
  }
  if (isPixInsightRunning()) {
    log('Stopping the running PixInsight instance…');
    await terminateRunning(slot);
  }

  fs.mkdirSync(path.join(BRIDGE_DIR, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(BRIDGE_DIR, 'results'), { recursive: true });
  fs.mkdirSync(path.join(BRIDGE_DIR, 'logs'), { recursive: true });
  // Any heartbeat still on disk describes the instance we just killed.
  try { fs.unlinkSync(HEARTBEAT); } catch {}

  const args = [`-n=${slot}`, '--no-splash', '--no-startup-check-updates', '--no-startup-gui-messages'];
  // Windowed mode is for watching PixInsight work; it reintroduces the modal
  // dialog hazard, so it is opt-in and never the default.
  if (!windowed) args.push('--automation-mode');
  args.push(`-r=${WATCHER}`);

  const stdoutLog = path.join(BRIDGE_DIR, 'logs', 'pixinsight-stdout.log');
  const out = fs.openSync(stdoutLog, 'a');
  fs.writeSync(out, `\n=== launch ${new Date().toISOString()} ===\n`);

  const child = spawn(PI_BIN, args, { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  log(`PixInsight starting (pid ${child.pid}, slot ${slot}, ${windowed ? 'windowed' : 'automation mode'})…`);

  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    await delay(1000);
    const status = watcherStatus();
    if (status.ok) {
      log(`Watcher ready: ${status.detail}`);
      return status;
    }
    if (!isPixInsightRunning()) {
      const tail = fs.readFileSync(stdoutLog, 'utf-8').split('\n').slice(-20).join('\n');
      throw new Error(`PixInsight exited during startup. Last output:\n${tail}`);
    }
  }

  throw new Error(
    `Timed out after ${timeout}s waiting for the watcher heartbeat at ${HEARTBEAT}.\n` +
    `PixInsight is running, so the watcher script did not load — a PJSR error that ` +
    `the core reports to its Process Console and nowhere else.\n` +
    `Run "node scripts/pjsr-lint.mjs pjsr" first: it catches the three failures that ` +
    `produce exactly this symptom with no message.\n` +
    `Then check ${stdoutLog} and PixInsight's Process Console.`
  );
}

if (import.meta.filename === process.argv[1]) {
  const opts = parseArgs(process.argv.slice(2));
  launch(opts).catch(err => {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  });
}
