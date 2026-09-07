// Prep used to run one fixed sequence for all twelve target categories, and
// extracted stars from every one — including the two whose stars are the whole
// subject. The knowledge to do otherwise was already in the repo, in three
// places, and prep read none of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { buildPrepPlan, describePrepPlan } from '../agents/prep-plan.mjs';
import { generateBrief } from '../agents/classifier.mjs';

const taxonomy = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '../agents/target-taxonomy.json'), 'utf-8')).categories;
const profiles = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '../agents/processing-profiles.json'), 'utf-8'));

const planFor = targetName =>
  buildPrepPlan(generateBrief({ files: { targetName, R: 'r', G: 'g', B: 'b', L: 'l' } }));

test('a target whose stars are the subject keeps its stars', () => {
  for (const name of ['NGC 2808', 'M13', 'M92', '47 Tuc', 'NGC 869', 'NGC 884']) {
    const plan = planFor(name);
    assert.equal(plan.extractStars.run, false, `${name} (${plan.classification}) would lose its subject`);
    assert.ok(plan.extractStars.reason, `${name} should say why`);
  }
});

test('a target whose stars are context still gets them extracted', () => {
  for (const name of ['M31', 'M42', 'NGC 6960', 'M97', 'NGC 891']) {
    const plan = planFor(name);
    assert.equal(plan.extractStars.run, true, `${name} (${plan.classification})`);
  }
});

test('every taxonomy category resolves to a decision', () => {
  for (const category of Object.keys(taxonomy)) {
    const plan = buildPrepPlan({
      target: { classification: category, fieldCharacteristics: taxonomy[category].traits },
      processingProfile: profiles[category],
    });
    assert.equal(typeof plan.extractStars.run, 'boolean', category);
    assert.ok(plan.extractStars.reason.length > 0, category);
  }
});

test('the trait and the profile agree across the taxonomy', () => {
  // They are two statements of the same fact, maintained separately. A
  // disagreement is a bug in one of them, and this is where it surfaces.
  for (const [category, entry] of Object.entries(taxonomy)) {
    const starsAreSubject = entry.traits.starRelationship === 'stars_are_subject';
    const profileSaysNo = profiles[category]?.tools?.SXT?.use === false;
    assert.equal(starsAreSubject, profileSaysNo,
      `${category}: trait says stars_are_subject=${starsAreSubject}, profile says SXT.use=${profiles[category]?.tools?.SXT?.use}`);
  }
});

test('every taxonomy category has a processing profile', () => {
  for (const category of Object.keys(taxonomy)) {
    assert.ok(profiles[category], `no processing profile for ${category}`);
  }
});

test('the profiles carry no category the taxonomy does not have', () => {
  // A profile keyed to a category that does not exist is dead: nothing can ever
  // select it. `star_cluster` sat here unused while both real cluster
  // categories fell through to the generic profile.
  for (const category of Object.keys(profiles)) {
    assert.ok(taxonomy[category], `processing profile "${category}" matches no taxonomy category`);
  }
});

test('the trait overrides a profile that disagrees, in the recoverable direction', () => {
  // An agent can remove stars later; it cannot put back a cluster prep deleted.
  const plan = buildPrepPlan({
    target: {
      classification: 'star_cluster_globular',
      fieldCharacteristics: { starRelationship: 'stars_are_subject' },
    },
    processingProfile: { tools: { SXT: { use: true } } },
  });
  assert.equal(plan.extractStars.run, false);
  assert.match(plan.extractStars.reason, /stars_are_subject/);
});

test('a missing directive leaves the previous behaviour in place', () => {
  const plan = buildPrepPlan({ target: { classification: 'mixed_field', fieldCharacteristics: {} } });
  assert.equal(plan.extractStars.run, true);
});

test('the plan describes itself for the log and the cache key', () => {
  assert.match(describePrepPlan(planFor('NGC 2808')), /star extraction: NO/);
  assert.match(describePrepPlan(planFor('M42')), /star extraction: yes/);
});
