// The lint exists because these three mistakes are silent: PixInsight reports
// none of them, and the symptom of all three is a script that appears not to run.
// A rule that stops firing is therefore invisible too, which is what these cover.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const REPO = path.join(import.meta.dirname, '..');
const LINT = path.join(REPO, 'scripts/pjsr-lint.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pjsr-lint-'));

/** Lint one snippet and return the rules it fired. */
function lint(source, { asPjsrFile = true } = {}) {
  // The engine-directive rule only applies to files PixInsight loads directly,
  // which the lint recognises by the pjsr/ directory and a .js extension.
  const dir = path.join(tmp, `case-${Math.random().toString(36).slice(2)}`, asPjsrFile ? 'pjsr' : 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, asPjsrFile ? 'script.js' : 'module.mjs');
  fs.writeFileSync(file, source);

  let stdout = '';
  try {
    stdout = execFileSync('node', [LINT, dir], { encoding: 'utf-8', cwd: REPO });
  } catch (e) {
    stdout = e.stdout ?? '';
  }
  return [...stdout.matchAll(/\[([a-z-]+)\]/g)].map(m => m[1]);
}

test('a clean PJSR file passes', () => {
  assert.deepEqual(lint('#engine v8\nvar x = SCNR.Green;\n'), []);
});

test('a missing engine directive is caught', () => {
  // Without it the core picks the legacy engine, which is absent on Apple
  // Silicon, and the file does not load.
  assert.ok(lint('var x = 1;\n').includes('missing-engine-directive'));
});

test('a slash-star pair inside a line comment is caught', () => {
  // The preprocessor opens a block comment that swallows the rest of the file.
  const rules = lint('#engine v8\n// headers live in pjsr/*.jsh these days\nvar x = 1;\n');
  assert.ok(rules.includes('block-comment-in-line-comment'));
});

test('a real block comment is not mistaken for one', () => {
  assert.deepEqual(lint('#engine v8\n/* an ordinary block comment */\nvar x = 1;\n'), []);
});

test('legacy prototype enum access is caught in Node modules too', () => {
  // Under V8 this reads as undefined; assigning it to a process parameter
  // throws with the bare message "undefined".
  const rules = lint('const code = `P.colorToRemove = SCNR.prototype.Green;`;\n', { asPjsrFile: false });
  assert.ok(rules.includes('legacy-prototype-enum'));
});

test('the current enum form is not flagged', () => {
  assert.deepEqual(lint('const code = `P.colorToRemove = SCNR.Green;`;\n', { asPjsrFile: false }), []);
});

test('a deprecated global is caught, and its replacement is not', () => {
  assert.ok(lint('const c = `processEvents();`;\n', { asPjsrFile: false }).includes('deprecated-global'));
  assert.deepEqual(lint('const c = `CoreApplication.processEvents();`;\n', { asPjsrFile: false }), []);
  assert.ok(lint('const c = `msleep(10);`;\n', { asPjsrFile: false }).includes('deprecated-global'));
  assert.deepEqual(lint('const c = `System.msleep(10);`;\n', { asPjsrFile: false }), []);
});

test('gc() is reported as removed rather than merely deprecated', () => {
  assert.ok(lint('const c = `gc();`;\n', { asPjsrFile: false }).includes('removed-global'));
});

test('a renamed ABE constant is caught without flagging its replacement', () => {
  assert.ok(lint('const c = `AutomaticBackgroundExtractor.Subtract`;\n', { asPjsrFile: false })
    .includes('renamed-constant'));
  assert.deepEqual(lint('const c = `AutomaticBackgroundExtractor.Correction_Subtract`;\n', { asPjsrFile: false }), []);
});
