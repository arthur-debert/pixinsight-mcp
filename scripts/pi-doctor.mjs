#!/usr/bin/env node
// Preflight for the PixInsight bridge.
//
// Run this before a pipeline, and run it first when something fails. Every check
// reports what it found rather than only pass/fail, because the failures worth
// catching here are the ones that otherwise show up hours later as a timeout.
//
// Usage: node scripts/pi-doctor.mjs [--json]

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { watcherStatus, createBridgeContext } from '../agents/ops/bridge.mjs';

const HOME = os.homedir();
const BRIDGE_DIR = path.join(HOME, '.pixinsight-mcp/bridge');
const PI_ROOT = '/Applications/PixInsight';
const PI_BIN = `${PI_ROOT}/PixInsight.app/Contents/MacOS/PixInsight`;
const MIN_FREE_GB = 20;

const checks = [];
const record = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix });

function checkPixInsightInstall() {
  if (!fs.existsSync(PI_BIN)) {
    return record('PixInsight install', false, `Not found at ${PI_BIN}`,
      'Install PixInsight, or edit PI_BIN in scripts/pi-launch.mjs if it lives elsewhere.');
  }
  let version = 'unknown';
  try {
    version = execFileSync('/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', `${PI_ROOT}/PixInsight.app/Contents/Info.plist`],
      { encoding: 'utf-8' }).trim();
  } catch { /* keep "unknown" */ }

  const [major, minor, release] = version.split('.').map(Number);
  const isV8Era = major > 1 || (major === 1 && (minor > 9 || (minor === 9 && release >= 4)));
  record('PixInsight install', true, `${version} at ${PI_ROOT}`);
  record('PJSR runtime', true,
    isV8Era
      ? `${version} runs the V8 runtime — PJSR files need "#engine v8" and cannot include the pjsr .jsh headers.`
      : `${version} predates 1.9.4, so it still runs SpiderMonkey. This fork targets the V8 runtime and its scripts will not load here.`);
}

function checkModules() {
  const required = {
    BlurXTerminator: 'BlurXTerminator-pxm.dylib',
    NoiseXTerminator: 'NoiseXTerminator-pxm.dylib',
    StarXTerminator: 'StarXTerminator-pxm.dylib',
  };
  for (const [name, file] of Object.entries(required)) {
    const p = path.join(PI_ROOT, 'bin', file);
    record(`${name} module`, fs.existsSync(p), fs.existsSync(p) ? p : `${file} not found in ${PI_ROOT}/bin`,
      `Install ${name} and confirm the module is registered in PixInsight.`);
  }
}

function checkBridgeDirs() {
  for (const sub of ['commands', 'results', 'logs']) {
    const p = path.join(BRIDGE_DIR, sub);
    const exists = fs.existsSync(p);
    record(`bridge/${sub}`, exists, exists ? p : 'missing', 'Run: npm run setup-bridge');
  }
  try {
    const pending = fs.readdirSync(path.join(BRIDGE_DIR, 'commands')).filter(f => f.endsWith('.json'));
    // Commands left behind belong to callers that already gave up. The next
    // watcher to start would run them out of context.
    record('command backlog', pending.length === 0,
      pending.length === 0 ? 'empty' : `${pending.length} unconsumed command file(s)`,
      `Remove them: rm ${path.join(BRIDGE_DIR, 'commands')}/*.json`);
  } catch { /* covered by the directory check above */ }
}

function checkDiskSpace() {
  try {
    const out = execFileSync('/bin/df', ['-g', HOME], { encoding: 'utf-8' });
    const free = Number(out.trim().split('\n')[1].split(/\s+/)[3]);
    record('disk space', free >= MIN_FREE_GB, `${free} GB free on the volume holding ${HOME}`,
      `Free up space; the pipeline wants at least ${MIN_FREE_GB} GB for swap files and intermediates.`);
  } catch {
    record('disk space', false, 'could not read free space');
  }
}

function checkWatcher() {
  const s = watcherStatus();
  record('watcher', s.ok, s.detail,
    s.ok ? undefined : 'Start or restart it: node scripts/pi-launch.mjs --restart');
  return s.ok;
}

async function checkRoundTrip() {
  try {
    const bridge = createBridgeContext({ log: () => {} });
    const t0 = Date.now();
    const r = await bridge.pjsr('CoreApplication.versionMajor + "." + CoreApplication.versionMinor + "." + CoreApplication.versionRelease');
    if (r.status !== 'ok') {
      return record('bridge round trip', false, `Watcher answered with an error: ${r.error?.message}`);
    }
    record('bridge round trip', true, `PJSR eval returned "${r.result}" in ${Date.now() - t0}ms`);
  } catch (e) {
    record('bridge round trip', false, e.message);
  }
}

async function main() {
  checkPixInsightInstall();
  checkModules();
  checkBridgeDirs();
  checkDiskSpace();
  if (checkWatcher()) await checkRoundTrip();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: checks.every(c => c.ok), checks }, null, 2));
  } else {
    const width = Math.max(...checks.map(c => c.name.length));
    for (const c of checks) {
      console.log(`${c.ok ? '  ok  ' : ' FAIL '} ${c.name.padEnd(width)}  ${c.detail}`);
      if (!c.ok && c.fix) console.log(`${' '.repeat(width + 9)}${c.fix}`);
    }
    const failed = checks.filter(c => !c.ok).length;
    console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
  }
  process.exit(checks.every(c => c.ok) ? 0 : 1);
}

main();
