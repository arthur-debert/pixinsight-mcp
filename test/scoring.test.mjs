// Scoring decides which candidate the art director picks, and the weight
// profiles are the only place the pipeline says what a target type is FOR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { DIMENSIONS, WEIGHT_PROFILES, HARD_CONSTRAINTS, computeAggregate, checkHardConstraints }
  from '../agents/scoring.mjs';

const CATEGORIES = Object.keys(
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../agents/target-taxonomy.json'), 'utf-8')).categories);

const flat = Object.fromEntries(DIMENSIONS.map(d => [d, 50]));

test('every weight profile covers every dimension', () => {
  for (const [profile, weights] of Object.entries(WEIGHT_PROFILES)) {
    for (const d of DIMENSIONS) {
      assert.ok(typeof weights[d] === 'number', `${profile} is missing ${d}`);
    }
  }
});

test('a weight profile has no dimensions the model does not score', () => {
  for (const [profile, weights] of Object.entries(WEIGHT_PROFILES)) {
    for (const key of Object.keys(weights)) {
      assert.ok(DIMENSIONS.includes(key), `${profile} weights unknown dimension ${key}`);
    }
  }
});

test('every taxonomy category has its own weight profile', () => {
  // A category with no profile used to fall back silently to the generic one,
  // which is how a globular cluster got scored like a mixed field.
  for (const category of CATEGORIES) {
    assert.ok(WEIGHT_PROFILES[category], `no weight profile for ${category}`);
    assert.ok(Number.isFinite(computeAggregate(flat, category).aggregate), category);
  }
});

test('an unknown target class is refused rather than scored generically', () => {
  assert.throws(() => computeAggregate(flat, 'star_cluster'), /No scoring weight profile/);
});

test('a flat scorecard aggregates to its own value under every profile', () => {
  // Whatever the weights are, weighting 50s with no artifacts can only produce
  // 50. A profile whose weights do not normalise shows up here and nowhere else.
  const clean = { ...flat, artifact_penalty: 0 };
  for (const category of Object.keys(WEIGHT_PROFILES)) {
    const { aggregate } = computeAggregate(clean, category);
    assert.ok(Math.abs(aggregate - 50) < 0.01, `${category} gave ${aggregate}`);
  }
});

test('artifacts subtract from the aggregate', () => {
  const clean = computeAggregate({ ...flat, artifact_penalty: 0 }, 'galaxy_spiral').aggregate;
  const dirty = computeAggregate({ ...flat, artifact_penalty: 100 }, 'galaxy_spiral').aggregate;
  assert.ok(dirty < clean, `${dirty} should be below ${clean}`);
});

test('the profiles disagree about what matters', () => {
  // If two target types weighted everything alike, the taxonomy would be
  // decorative. A globular is about its stars; a spiral is about detail.
  const globular = WEIGHT_PROFILES.star_cluster_globular;
  const spiral = WEIGHT_PROFILES.galaxy_spiral;
  if (globular && spiral) {
    assert.ok(globular.star_integrity > spiral.star_integrity,
      'a globular cluster should weight star integrity above a spiral galaxy');
  }
});

test('hard constraints reject a blown image and accept a sane one', () => {
  const brief = { hardConstraints: HARD_CONSTRAINTS };
  const sane = checkHardConstraints({ median: 0.1, max: 0.9 }, brief);
  assert.equal(sane.pass, true, JSON.stringify(sane.violations));

  const blown = checkHardConstraints({ median: 0.1, max: 1.0 }, brief);
  assert.equal(blown.pass, false);
  assert.ok(blown.violations.length > 0);
});

test('hard constraints reject a background that was crushed or lifted', () => {
  const brief = { hardConstraints: HARD_CONSTRAINTS };
  assert.equal(checkHardConstraints({ median: 0.0001, max: 0.9 }, brief).pass, false);
  assert.equal(checkHardConstraints({ median: 0.5, max: 0.9 }, brief).pass, false);
});
