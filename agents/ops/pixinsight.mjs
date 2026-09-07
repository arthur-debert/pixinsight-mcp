// ============================================================================
// Starting and stopping the PixInsight application
// ============================================================================
//
// Two failure modes make `PixInsight -r=watcher.js &` unusable on its own:
//
//   1. In windowed mode a PJSR error opens a modal dialog. Nothing on the Node
//      side can dismiss it, the process sits at 0% CPU forever, and every bridge
//      call times out with no explanation. Automation mode routes those errors
//      to the console instead of a dialog box.
//   2. A script that fails to load looks exactly like one that loaded fine:
//      PixInsight is running either way. The watcher's heartbeat settles that,
//      and launch() waits on it rather than on the process appearing.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFileSync } from 'child_process';
import { watcherStatus, isPixInsightRunning } from './bridge.mjs';

const HOME = os.homedir();

export const BRIDGE_DIR = path.join(HOME, '.pixinsight-mcp/bridge');
export const HEARTBEAT_PATH = path.join(BRIDGE_DIR, 'watcher.json');
export const STDOUT_LOG = path.join(BRIDGE_DIR, 'logs', 'pixinsight-stdout.log');
export const PI_BIN = '/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight';
export const WATCHER_PATH = path.resolve(import.meta.dirname, '../../pjsr/pixinsight-mcp-watcher.js');

// Named delay, not sleep: PJSR has a deprecated global by that name and the
// lint should keep flagging any call to it.
const delay = ms => new Promise(r => setTimeout(r, ms));

export function ensureBridgeDirectories() {
  for (const sub of ['commands', 'results', 'logs']) {
    fs.mkdirSync(path.join(BRIDGE_DIR, sub), { recursive: true });
  }
}

export async function terminatePixInsight(slot = 1) {
  try {
    execFileSync(PI_BIN, [`--terminate=${slot}`], { timeout: 30_000, stdio: 'ignore' });
  } catch { /* no instance in that slot */ }
  for (let i = 0; i < 20 && isPixInsightRunning(); i++) await delay(500);
  try {
    execFileSync('/usr/bin/pkill', ['-f', 'PixInsight.app/Contents/MacOS/PixInsight'], { stdio: 'ignore' });
  } catch {}
  await delay(2000);
}

/**
 * Start PixInsight with the watcher loaded and wait until it answers.
 *
 * @param {object} opts
 *   slot      application slot, 1 by default
 *   timeout   seconds to wait for the heartbeat
 *   restart   stop a running instance first
 *   windowed  show the UI; reintroduces the modal dialog hazard, so opt-in only
 *   log       where progress goes
 * @returns the watcher status once it is answering
 */
export async function launch(opts = {}) {
  const { slot = 1, timeout = 120, restart = false, windowed = false, log = console.log } = opts;

  if (!fs.existsSync(PI_BIN)) throw new Error(`PixInsight not found at ${PI_BIN}`);
  if (!fs.existsSync(WATCHER_PATH)) throw new Error(`Watcher script not found at ${WATCHER_PATH}`);

  const existing = watcherStatus();
  if (existing.ok && !restart) {
    log(`Watcher already alive: ${existing.detail}`);
    return existing;
  }
  if (isPixInsightRunning()) {
    log('Stopping the running PixInsight instance…');
    await terminatePixInsight(slot);
  }

  ensureBridgeDirectories();
  // Any heartbeat still on disk describes the instance we just killed.
  try { fs.unlinkSync(HEARTBEAT_PATH); } catch {}

  const args = [`-n=${slot}`, '--no-splash', '--no-startup-check-updates', '--no-startup-gui-messages'];
  if (!windowed) args.push('--automation-mode');
  args.push(`-r=${WATCHER_PATH}`);

  const out = fs.openSync(STDOUT_LOG, 'a');
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
      const tail = fs.readFileSync(STDOUT_LOG, 'utf-8').split('\n').slice(-20).join('\n');
      throw new Error(`PixInsight exited during startup. Last output:\n${tail}`);
    }
  }

  throw new Error(
    `Timed out after ${timeout}s waiting for the watcher heartbeat at ${HEARTBEAT_PATH}.\n` +
    `PixInsight is running, so the watcher script did not load — a PJSR error that ` +
    `the core reports to its Process Console and nowhere else.\n` +
    `Run "node scripts/pjsr-lint.mjs pjsr" first: it catches the three failures that ` +
    `produce exactly this symptom with no message.\n` +
    `Then check ${STDOUT_LOG} and PixInsight's Process Console.`
  );
}
