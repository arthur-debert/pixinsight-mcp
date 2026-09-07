#!/usr/bin/env node
// Import every module in the repo, so a broken import path fails here rather
// than minutes into a processing run in the one file nothing else touches.
//
// Entry points are skipped: they do work on import rather than exporting it.

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const SKIP = new Set([
  'agents/mcp/server.mjs',        // starts a stdio server
  'agents/orchestrator.mjs',      // CLI entry point
  'agents/llm/orchestrator.mjs',  // CLI entry point
  'agents/llm/giga-run.mjs',      // CLI entry point
  'editor/server.mjs',            // starts an HTTP server
]);
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'test', 'scripts', 'pjsr', '.git']);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.mjs')) yield p;
  }
}

const failures = [];
let checked = 0;
for (const file of walk('agents')) {
  if (SKIP.has(file)) continue;
  checked++;
  try {
    await import(pathToFileURL(path.resolve(file)).href);
  } catch (err) {
    failures.push({ file, message: err.message });
  }
}

for (const f of failures) console.error(`${f.file}\n    ${f.message}\n`);
console.log(`${checked} module(s) checked, ${failures.length} failed.`);
process.exit(failures.length === 0 ? 0 : 1);
