#!/usr/bin/env node
// Start PixInsight with the MCP watcher loaded, and do not return until the
// watcher has actually answered. The work lives in agents/ops/pixinsight.mjs so
// the MCP server can start PixInsight exactly the way this does.
//
// Usage:
//   node scripts/pi-launch.mjs [--slot N] [--timeout SECONDS] [--restart] [--windowed]

import { launch } from '../agents/ops/pixinsight.mjs';

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

launch(parseArgs(process.argv.slice(2))).catch(err => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
