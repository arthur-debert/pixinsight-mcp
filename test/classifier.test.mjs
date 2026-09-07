// The classification drives every trait in the processing brief, so a wrong one
// steers the whole run. These cases are the ones that were actually wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { generateBrief } from '../agents/classifier.mjs';

const CATEGORIES = new Set(Object.keys(
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../agents/target-taxonomy.json'), 'utf-8')).categories));

const classify = (targetName, files = {}) =>
  generateBrief({ files: { targetName, R: 'r', G: 'g', B: 'b', ...files } }).target;

test('every classification it can produce exists in the taxonomy', () => {
  const names = [
    'M31', 'M42', 'M45', 'M13', 'M2', 'M20', 'M1', 'M97', 'NGC 2808', 'NGC 104',
    'NGC 5139', 'NGC 891', 'NGC 6960', 'Abell 2151', 'Barnard 33', 'IC 4628',
    'Rho Ophiuchi', 'Some Unknown Blob', 'a globular cluster', 'an open cluster',
    'the galaxy cluster', 'planetary', 'a dark nebula', 'a remnant', '', '12345',
  ];
  for (const n of names) {
    const t = classify(n);
    assert.ok(CATEGORIES.has(t.classification), `${n} produced ${t.classification}`);
  }
});

test('NGC 2808 is a globular cluster', () => {
  assert.equal(classify('NGC 2808').classification, 'star_cluster_globular');
});

test('designations survive the punctuation folder names carry', () => {
  for (const n of ['NGC 2808', 'NGC-2808', 'ngc_2808', 'NGC2808_LRGB',
                   'ngc_2808_d12ece927e8e441294e578bdf04b3944']) {
    assert.equal(classify(n).classification, 'star_cluster_globular', n);
  }
});

test('a short designation does not claim a longer number', () => {
  // M2 is a globular and M20 is the Trifid. Substring matching classified one
  // as the other depending on table order.
  assert.equal(classify('M2').classification, 'star_cluster_globular');
  assert.equal(classify('M20').classification, 'emission_nebula');
  // NGC 104 is 47 Tucanae; NGC 1042 is a spiral galaxy and is not in the table.
  assert.equal(classify('NGC 104').classification, 'star_cluster_globular');
  assert.notEqual(classify('NGC 1042').classificationSource, 'name');
});

test('common names are found even when folder names run words together', () => {
  assert.equal(classify('NGC-6990-TheVeil').classification, 'supernova_remnant');
  assert.equal(classify('C106-TUC-47-Tucana-Cluster').classification, 'star_cluster_globular');
  assert.equal(classify('NGC-253-SculptorGalaxy').classification, 'galaxy_spiral');
  assert.equal(classify('IC-4628-PrawnNebula').classification, 'emission_nebula');
});

test('an unmatched name is reported as a fallback, not passed off as deliberate', () => {
  // mixed_field is a real category — Rho Ophiuchi belongs there — so an unknown
  // target landing on it must stay distinguishable from one that was chosen.
  const unknown = classify('Some Unknown Blob');
  assert.equal(unknown.classification, 'mixed_field');
  assert.equal(unknown.classificationSource, 'fallback');

  assert.equal(classify('M31').classificationSource, 'name');
});

test('"cluster" alone is too ambiguous to classify', () => {
  // Globular, open and galaxy clusters process nothing alike.
  assert.equal(classify('The Cluster').classificationSource, 'fallback');
  assert.equal(classify('a globular cluster').classification, 'star_cluster_globular');
  assert.equal(classify('an open cluster').classification, 'star_cluster_open');
  assert.equal(classify('the galaxy cluster').classification, 'galaxy_cluster');
});

test('a classification outside the taxonomy is refused rather than used', () => {
  assert.throws(
    () => generateBrief({ files: { targetName: 'M31', R: 'r', G: 'g', B: 'b' } },
                        { classification: 'star_cluster' }),
    /not in target-taxonomy/);
});

test('the workflow follows the channels the config supplies', () => {
  const workflow = files => generateBrief({ files: { targetName: 'M81', ...files } }).dataDescription.workflow;
  assert.equal(workflow({ R: 'r', G: 'g', B: 'b' }), 'RGB');
  assert.equal(workflow({ R: 'r', G: 'g', B: 'b', L: 'l' }), 'LRGB');
  assert.equal(workflow({ R: 'r', G: 'g', B: 'b', Ha: 'h' }), 'HaRGB');
  assert.equal(workflow({ R: 'r', G: 'g', B: 'b', L: 'l', Ha: 'h' }), 'HaLRGB');
  assert.equal(workflow({ L: 'l' }), 'L_only');
  // Empty strings mean "this filter was not shot", not "this filter exists".
  assert.equal(workflow({ R: 'r', G: 'g', B: 'b', L: '  ', Ha: '' }), 'RGB');
});
