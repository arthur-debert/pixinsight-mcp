#!/usr/bin/env node
// Catch the PJSR mistakes that PixInsight does not report.
//
// Three of them cost real debugging time on the 1.9.4 port, and all three are
// silent: the script simply does nothing, or writes a wrong number into a
// process parameter and carries on.
//
//   1. A slash-star pair inside a line comment. The preprocessor scans for
//      comment delimiters without tracking which comment it is inside, so the
//      pair opens a block comment that swallows the rest of the file. The script
//      never loads and PixInsight prints nothing at all.
//   2. A missing engine directive. Without it the core selects the legacy
//      SpiderMonkey engine, which no longer ships on Apple Silicon.
//   3. Legacy enumeration access through .prototype. Under V8 this evaluates to
//      undefined rather than throwing, and assigning undefined to a process
//      parameter fails with the message "undefined" and nothing else.
//
// Usage: node scripts/pjsr-lint.mjs [paths...]      (defaults to pjsr/ and agents/)

import fs from 'fs';
import path from 'path';

// Process classes whose enumerations moved from the prototype to the class.
const PI_PROCESS_CLASSES = [
  'PixelMath', 'Convolution', 'Resample', 'AutomaticBackgroundExtractor',
  'ChannelExtraction', 'SCNR', 'LocalHistogramEqualization', 'ChannelCombination',
  'StarAlignment', 'SpectrophotometricColorCalibration', 'MorphologicalTransformation',
  'HDRMultiscaleTransform', 'ImageSolver', 'Deconvolution', 'CurvesTransformation',
  'HistogramTransformation', 'StarXTerminator', 'NoiseXTerminator', 'BlurXTerminator',
  'GradientCorrection', 'ImageIntegration', 'Debayer', 'Rotation', 'Crop',
];
const PROTOTYPE_ENUM = new RegExp(`\\b(${PI_PROCESS_CLASSES.join('|')})\\.prototype\\.(\\w+)`, 'g');

// Globals that 1.9.4 moved onto the class that owns them. The legacy names still
// work and still do the right thing, but each prints a deprecation warning once
// per runtime — easy to miss, and a promise that they will stop working.
const DEPRECATED_GLOBALS = {
  processEvents: 'CoreApplication.processEvents',
  msleep: 'System.msleep',
  sleep: 'System.sleep',
  searchDirectory: 'File.searchDirectory',
  cpuId: 'System.cpuId',
  cpuInfo: 'System.cpuInfo',
  getEnvironmentVariable: 'System.getEnvironmentVariable',
  replaceEnvironmentVariables: 'System.replaceEnvironmentVariables',
  physicalMemoryStatus: 'System.physicalMemoryStatus',
  systemOffsetFromUTC: 'System.offsetFromUTC',
  loadResource: 'CoreApplication.loadResource',
  unloadResource: 'CoreApplication.unloadResource',
};
// gc() went away without a replacement: the V8 runtime collects on its own, and
// core memory is released through ImageWindow.purge().
const REMOVED_GLOBALS = {
  gc: 'nothing — the V8 runtime collects on its own; release core memory with ImageWindow.purge()',
};

// AutomaticBackgroundExtractor's enumerations gained parameter-scoped prefixes.
const RENAMED_CONSTANTS = {
  'AutomaticBackgroundExtractor.Subtract': 'AutomaticBackgroundExtractor.Correction_Subtract',
  'AutomaticBackgroundExtractor.Divide': 'AutomaticBackgroundExtractor.Correction_Divide',
  'AutomaticBackgroundExtractor.None': 'AutomaticBackgroundExtractor.Correction_None',
  'AutomaticBackgroundExtractor.SameAsTarget': 'AutomaticBackgroundExtractor.CorrectedFormat_SameAsTarget',
};

function lintSource(file, text, { isPjsrFile }) {
  const findings = [];
  const lines = text.split('\n');

  if (isPjsrFile) {
    const firstCode = lines.find(l => l.trim() && !l.trim().startsWith('//'));
    if (!/^#engine\s+v8/.test(lines[0] ?? '') && !lines.some(l => /^#engine\s+v8/.test(l))) {
      findings.push({
        line: 1, rule: 'missing-engine-directive',
        message: 'No "#engine v8" directive. PixInsight 1.9.4+ will try the legacy SpiderMonkey engine, which is absent on Apple Silicon, and the file will not load.',
        context: firstCode ?? lines[0] ?? '',
      });
    }
  }

  lines.forEach((line, i) => {
    const n = i + 1;

    const comment = line.indexOf('//');
    if (comment !== -1 && line.indexOf('/*', comment) !== -1) {
      findings.push({
        line: n, rule: 'block-comment-in-line-comment',
        message: 'A slash-star pair inside a line comment opens a block comment that runs to the end of the file. The script will fail to load with no error message.',
        context: line.trim(),
      });
    }

    for (const m of line.matchAll(PROTOTYPE_ENUM)) {
      findings.push({
        line: n, rule: 'legacy-prototype-enum',
        message: `${m[0]} is undefined under the V8 runtime. Use ${m[1]}.${m[2]} instead — assigning the undefined value to a process parameter throws with the bare message "undefined".`,
        context: line.trim(),
      });
    }

    for (const [legacy, replacement] of Object.entries(DEPRECATED_GLOBALS)) {
      // Only a bare call: a property access like System.msleep is the fix, not the bug.
      if (new RegExp(`(?<![\\w.])${legacy}\\s*\\(`).test(line)) {
        findings.push({
          line: n, rule: 'deprecated-global',
          message: `${legacy}() is deprecated in PixInsight 1.9.4. Use ${replacement}() instead.`,
          context: line.trim(),
        });
      }
    }

    for (const [removed, note] of Object.entries(REMOVED_GLOBALS)) {
      if (new RegExp(`(?<![\\w.])${removed}\\s*\\(`).test(line)) {
        findings.push({
          line: n, rule: 'removed-global',
          message: `${removed}() was removed in PixInsight 1.9.4. Replace it with ${note}.`,
          context: line.trim(),
        });
      }
    }

    for (const [legacy, replacement] of Object.entries(RENAMED_CONSTANTS)) {
      // Word boundary on the right so Correction_Subtract does not match Subtract.
      if (new RegExp(`\\b${legacy.replace('.', '\\.')}\\b`).test(line)) {
        findings.push({
          line: n, rule: 'renamed-constant',
          message: `${legacy} was renamed under the V8 runtime. Use ${replacement}.`,
          context: line.trim(),
        });
      }
    }
  });

  return findings;
}

function* walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) { yield target; return; }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(target, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.(js|jsh|mjs)$/.test(entry.name)) yield p;
  }
}

const targets = process.argv.slice(2);
const roots = targets.length ? targets : ['pjsr', 'agents', 'scripts'];

let total = 0;
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    // This file carries the rule table, so every pattern it names matches here.
    if (path.resolve(file) === path.resolve(import.meta.filename)) continue;
    const text = fs.readFileSync(file, 'utf-8');
    // Only files loaded directly by PixInsight need the engine directive; the
    // Node modules merely build strings that the watcher evaluates.
    const isPjsrFile = file.includes(`pjsr${path.sep}`) && /\.js$/.test(file);
    const findings = lintSource(file, text, { isPjsrFile });
    for (const f of findings) {
      console.log(`${file}:${f.line}  [${f.rule}]\n    ${f.message}\n    > ${f.context}\n`);
      total++;
    }
  }
}

if (total === 0) {
  console.log('pjsr-lint: clean');
} else {
  console.log(`pjsr-lint: ${total} finding(s)`);
  process.exit(1);
}
