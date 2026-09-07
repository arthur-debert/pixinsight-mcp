#!/usr/bin/env node
// Preflight for the PixInsight bridge.
//
// Run this before a pipeline, and run it first when something fails. The checks
// are the same ones the MCP server runs at startup — they live in
// agents/mcp/preflight.mjs so there is one answer to "is this thing ready".
//
// Usage: node scripts/pi-doctor.mjs [--json]

import { inspectInstallation, statusReport } from '../agents/mcp/preflight.mjs';
import { createBridgeContext, watcherStatus } from '../agents/ops/bridge.mjs';

async function roundTrip() {
  const t0 = Date.now();
  try {
    const bridge = createBridgeContext({ log: () => {} });
    const r = await bridge.pjsr(
      'CoreApplication.versionMajor + "." + CoreApplication.versionMinor + "." + CoreApplication.versionRelease');
    if (r.status !== 'ok') {
      return { name: 'bridge round trip', ok: false, detail: `watcher answered with an error: ${r.error?.message}` };
    }
    return { name: 'bridge round trip', ok: true, detail: `PJSR eval returned "${r.result}" in ${Date.now() - t0}ms` };
  } catch (e) {
    return { name: 'bridge round trip', ok: false, detail: e.message };
  }
}

const FIXES = {
  PixInsight: 'Install PixInsight, or correct PI_BIN in agents/ops/pixinsight.mjs.',
  BlurXTerminator: 'Install BlurXTerminator and confirm PixInsight registers the module.',
  NoiseXTerminator: 'Install NoiseXTerminator and confirm PixInsight registers the module.',
  StarXTerminator: 'Install StarXTerminator and confirm PixInsight registers the module.',
  'disk space': 'Free up space; the pipeline wants at least 20 GB for swap files and intermediates.',
  'command backlog': 'Clear them: rm ~/.pixinsight-mcp/bridge/commands/*.json',
  watcher: 'Start or restart it: node scripts/pi-launch.mjs --restart',
  'bridge round trip': 'The watcher is answering but PJSR is failing. Check ~/.pixinsight-mcp/bridge/logs/.',
};

const checks = inspectInstallation();
const watcher = watcherStatus();
checks.push({ name: 'watcher', ok: watcher.ok, detail: watcher.detail });
if (watcher.ok) checks.push(await roundTrip());

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: checks.every(c => c.ok), checks }, null, 2));
} else {
  const width = Math.max(...checks.map(c => c.name.length));
  for (const c of checks) {
    console.log(`${c.ok ? '  ok  ' : ' FAIL '} ${c.name.padEnd(width)}  ${c.detail}`);
    if (!c.ok && FIXES[c.name]) console.log(`${' '.repeat(width + 9)}${FIXES[c.name]}`);
  }
  const failed = checks.filter(c => !c.ok).length;
  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
}
process.exit(checks.every(c => c.ok) ? 0 : 1);
