#!/usr/bin/env node
// Check every PixInsight process parameter this repo sets against the process
// that will receive it.
//
// Assigning a parameter a process does not have is accepted in silence: it
// becomes an ordinary JavaScript property and the process ignores it.
//
//     var P = new HDRMultiscaleTransform;
//     P.scalingFunctionNoiseLayers = 1;   // no such parameter in 1.9.4
//
// Nothing fails. The process runs with a different configuration than the code
// appears to request, and the only evidence is a different image. Parameters
// removed or renamed between PixInsight versions land here, which makes this the
// check that matters most after a core upgrade.
//
// The audit reads the PJSR the repo generates, groups assignments by the process
// each variable holds, then asks the running PixInsight what each process really
// accepts.
//
// Scope defaults to the maintained code — agents/ and pjsr/. scripts/ holds the
// superseded deterministic pipeline and a set of one-off research scripts, and
// it has around 90 findings of its own; pass it explicitly to see them:
//
//     node scripts/pjsr-audit-params.mjs scripts
//
// Usage: node scripts/pjsr-audit-params.mjs [--json] [paths...]

import fs from 'fs';
import path from 'path';
import { createBridgeContext } from '../agents/ops/bridge.mjs';
import { ensureWatcher } from '../agents/mcp/preflight.mjs';

// `var P = new BlurXTerminator` / `let SA = new StarAlignment;`
const CONSTRUCTION = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Z][\w]*)\s*[;(\n]/g;
// `P.correct_only = true;`  — an assignment, not a read or a method call.
const ASSIGNMENT = /\b([A-Za-z_$][\w$]*)\.([a-zA-Z_$][\w$]*)\s*=(?!=)/g;

// `new Error(...)`, `new Map()` and friends match the construction pattern too.
// They are not processes and have nothing to check against.
const JS_BUILTINS = new Set([
  'Error', 'TypeError', 'RangeError', 'Date', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Array', 'Object', 'RegExp', 'Promise', 'Function', 'String', 'Number', 'Boolean',
]);

// Properties every process instance carries. They are not parameters, and
// nothing in this repo should be assigning them.
const PROCESS_MEMBERS = new Set([
  'assign', 'canExecuteGlobal', 'canExecuteGlobalOrThrow', 'canExecuteOn',
  'canExecuteOnOrThrow', 'canLaunchInterface', 'canProcessGlobal',
  'canProcessImages', 'canProcessViews', 'description', 'executeGlobal',
  'executeOn', 'executionTime', 'fromIcon', 'icons', 'iconsByProcessId',
  'isAssignable', 'isHistoryUpdater', 'isMaskable', 'launch', 'launchInterface',
  'processCategory', 'processId', 'readIcon', 'setDescription', 'startJD',
  'toSource', 'validate', 'validateOrThrow', 'writeIcon', 'writeInstanceAddr',
]);

/**
 * Find, per file, which process class each variable holds and which properties
 * are then assigned on it.
 *
 * Scoping is approximate: a variable is attributed to the most recent `new`
 * before the assignment. That matches how these snippets are written — one
 * process per block, constructed immediately before it is configured — and a
 * wrong attribution shows up as a reported parameter that does exist elsewhere,
 * which is visible rather than silent.
 */
function collectAssignments(source, file) {
  const constructions = [...source.matchAll(CONSTRUCTION)]
    .map(m => ({ index: m.index, variable: m[1], processClass: m[2] }));
  if (constructions.length === 0) return [];

  const found = [];
  for (const m of source.matchAll(ASSIGNMENT)) {
    const [, variable, property] = m;
    let holder = null;
    for (const c of constructions) {
      if (c.index < m.index && c.variable === variable) holder = c;
    }
    if (!holder || JS_BUILTINS.has(holder.processClass)) continue;
    found.push({
      file,
      line: source.slice(0, m.index).split('\n').length,
      processClass: holder.processClass,
      property,
      text: source.slice(m.index, source.indexOf('\n', m.index)).trim(),
    });
  }
  return found;
}

function* walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) { yield target; return; }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(target, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.(js|mjs)$/.test(entry.name)) yield p;
  }
}

/** Ask PixInsight what a set of process classes actually accepts. */
async function readProcessParameters(ctx, classNames) {
  const r = await ctx.pjsr(`
    var names = ${JSON.stringify([...classNames])};
    var out = {};
    for (var i = 0; i < names.length; ++i) {
      try {
        var cls = eval(names[i]);
        if (typeof cls !== "function") { out[names[i]] = null; continue; }
        out[names[i]] = Object.keys(new cls);
      } catch (e) {
        out[names[i]] = null;
      }
    }
    JSON.stringify(out);
  `);
  if (r.status === 'error') throw new Error(`Could not read process parameters: ${r.error.message}`);
  return JSON.parse((r.outputs?.consoleOutput || '{}').trim());
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const roots = args.filter(a => !a.startsWith('--'));
const targets = roots.length ? roots : ['agents', 'pjsr'];

const assignments = [];
for (const root of targets) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    assignments.push(...collectAssignments(fs.readFileSync(file, 'utf-8'), file));
  }
}

const classNames = new Set(assignments.map(a => a.processClass));
await ensureWatcher({ log: msg => console.error(msg) });
const ctx = createBridgeContext({ log: () => {} });
const known = await readProcessParameters(ctx, classNames);

const findings = [];
for (const a of assignments) {
  const params = known[a.processClass];
  // Not a process class at all (a helper object, a local class) — nothing to say.
  if (params === null || params === undefined) continue;
  if (params.includes(a.property)) continue;
  findings.push({
    ...a,
    kind: PROCESS_MEMBERS.has(a.property) ? 'assigns-a-process-member' : 'unknown-parameter',
    closest: params.filter(p => p.toLowerCase().includes(a.property.toLowerCase().slice(0, 6))).slice(0, 3),
  });
}

const unresolved = [...classNames].filter(c => known[c] === null || known[c] === undefined);

if (asJson) {
  console.log(JSON.stringify({ checked: assignments.length, findings, unresolved }, null, 2));
} else {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, items] of [...byFile].sort()) {
    console.log(`\n${file}  (${items.length})`);
    for (const f of items) {
      const suggestion = f.closest.length ? `  → did you mean ${f.closest.join(' / ')}?` : '';
      console.log(`  ${String(f.line).padStart(5)}  ${f.processClass}.${f.property}${suggestion}`);
    }
  }
  console.log(`\nChecked ${assignments.length} parameter assignments across ${classNames.size} classes.`);
  if (unresolved.length) {
    console.log(`Not PixInsight processes, skipped: ${unresolved.join(', ')}`);
  }
  console.log(findings.length === 0 ? 'No unknown parameters.' : `${findings.length} finding(s).`);
}

process.exit(findings.length === 0 ? 0 : 1);
