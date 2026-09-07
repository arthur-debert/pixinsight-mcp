// ============================================================================
// Making the MCP server self-sufficient
// ============================================================================
//
// An MCP server that starts cleanly while PixInsight is not running hands the
// model a full tool list where every call times out. Nothing in the protocol
// says "this server is here but its backend is not", so the answer is to check
// before serving, to start PixInsight rather than asking a human to, and to
// give the model a tool that reports the backend's state directly.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { watcherStatus } from '../ops/bridge.mjs';
import { launch, PI_BIN, BRIDGE_DIR, STDOUT_LOG } from '../ops/pixinsight.mjs';

const PI_ROOT = '/Applications/PixInsight';
const REQUIRED_MODULES = {
  BlurXTerminator: 'BlurXTerminator-pxm.dylib',
  NoiseXTerminator: 'NoiseXTerminator-pxm.dylib',
  StarXTerminator: 'StarXTerminator-pxm.dylib',
};
const MIN_FREE_GB = 20;

/**
 * Everything checkable without talking to PixInsight. Fast enough to run at
 * startup and again whenever the model asks.
 */
export function inspectInstallation() {
  const findings = [];
  const installed = fs.existsSync(PI_BIN);
  findings.push({
    name: 'PixInsight',
    ok: installed,
    detail: installed ? `${coreVersion() ?? 'unknown version'} at ${PI_ROOT}` : `not found at ${PI_BIN}`,
  });

  for (const [name, file] of Object.entries(REQUIRED_MODULES)) {
    const present = fs.existsSync(path.join(PI_ROOT, 'bin', file));
    findings.push({
      name,
      ok: present,
      detail: present ? 'installed' : `${file} missing from ${PI_ROOT}/bin`,
    });
  }

  const free = freeGigabytes();
  findings.push({
    name: 'disk space',
    ok: free === null || free >= MIN_FREE_GB,
    detail: free === null ? 'unreadable' : `${free} GB free`,
  });

  // Commands left in the directory belong to callers that already gave up.
  // The next watcher to start would run them, out of order and out of context.
  const backlog = abandonedCommands();
  findings.push({
    name: 'command backlog',
    ok: backlog === 0,
    detail: backlog === 0 ? 'empty' : `${backlog} abandoned command file(s)`,
  });

  return findings;
}

function coreVersion() {
  try {
    return execFileSync('/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', `${PI_ROOT}/PixInsight.app/Contents/Info.plist`],
      { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function freeGigabytes() {
  try {
    const out = execFileSync('/bin/df', ['-g', os.homedir()], { encoding: 'utf-8' });
    return Number(out.trim().split('\n')[1].split(/\s+/)[3]);
  } catch {
    return null;
  }
}

// The watcher deletes a command file before running it, so a file that is
// present has simply not been picked up yet — which is the normal state for a
// second or two on every call. Only an old one means nobody is coming for it.
const ABANDONED_AFTER_MS = 120_000;

function abandonedCommands() {
  const dir = path.join(BRIDGE_DIR, 'commands');
  try {
    const cutoff = Date.now() - ABANDONED_AFTER_MS;
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .filter(f => {
        try { return fs.statSync(path.join(dir, f)).mtimeMs < cutoff; } catch { return false; }
      }).length;
  } catch {
    return 0;
  }
}

/**
 * Refuse to serve tools that cannot possibly work. Returns the blocking
 * findings; an empty array means the installation is usable.
 */
export function blockingInstallationProblems() {
  return inspectInstallation().filter(f => !f.ok && f.name !== 'command backlog' && f.name !== 'disk space');
}

/**
 * Make sure the watcher is answering, starting PixInsight if it is not.
 *
 * Serialised through a single promise: several tool calls can arrive while the
 * application is still coming up, and each one starting its own instance would
 * leave a set of watchers competing for the same command directory.
 */
let inFlight = null;

export async function ensureWatcher({ autoLaunch = true, timeout = 180, log = () => {} } = {}) {
  const status = watcherStatus();
  if (status.ok) return status;

  if (!autoLaunch) {
    throw new Error(
      `PixInsight is not ready: ${status.detail}\n` +
      `Auto-launch is disabled for this server, so start it yourself: node scripts/pi-launch.mjs`);
  }

  if (!inFlight) {
    log(`PixInsight not ready (${status.reason}) — starting it.`);
    inFlight = launch({ timeout, log })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/**
 * The report behind the pixinsight_status tool. Written for a model deciding
 * what to do next, so every failure carries the command that fixes it.
 */
export async function statusReport() {
  const install = inspectInstallation();
  const watcher = watcherStatus();

  const lines = install.map(f => `${f.ok ? 'ok  ' : 'FAIL'}  ${f.name}: ${f.detail}`);
  lines.push(`${watcher.ok ? 'ok  ' : 'FAIL'}  watcher: ${watcher.detail}`);

  if (watcher.ok && watcher.heartbeat) {
    const hb = watcher.heartbeat;
    lines.push(`      core ${hb.coreVersion}, watcher v${hb.version}, ${hb.commandsProcessed} command(s) processed`);
    if (hb.state === 'busy' && hb.currentCommand) {
      lines.push(`      currently running ${hb.currentCommand.tool} since ${hb.currentCommand.startedAt}`);
    }
  } else if (!watcher.ok) {
    lines.push(`      recover with: node scripts/pi-launch.mjs --restart`);
    lines.push(`      PixInsight's own output: ${STDOUT_LOG}`);
  }

  const healthy = watcher.ok && install.every(f => f.ok);
  return { healthy, text: lines.join('\n') };
}
