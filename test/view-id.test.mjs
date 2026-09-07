// View identifiers follow C identifier rules. Under the V8 runtime,
// ImageWindow.windowById() throws on a malformed one with the message
// "undefined" and nothing else, several steps after the name was set.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toViewId } from '../agents/ops/image-mgmt.mjs';

const VALID = /^[A-Za-z_][A-Za-z0-9_]*$/;

test('every result is a legal identifier', () => {
  const names = [
    'NGC 2808', 'NGC-2808', 'M-80 Lagoon/Trifid', 'Rho Ophiuchi', '2808',
    '47 Tuc', 'Sh2-155', 'M31 (Andromeda)', 'target.v2', '  padded  ',
    'Coma Berenices — Abell 1656', 'ω Centauri', '___', '!!!', '',
  ];
  for (const n of names) {
    assert.match(toViewId(n), VALID, `${JSON.stringify(n)} produced ${toViewId(n)}`);
  }
});

test('names that are already legal are left alone', () => {
  for (const n of ['NGC_2808', 'M31', 'FILTER_L', '_stars']) {
    assert.equal(toViewId(n), n);
  }
});

test('spaces and punctuation become underscores', () => {
  assert.equal(toViewId('NGC 2808'), 'NGC_2808');
  assert.equal(toViewId('NGC-2808'), 'NGC_2808');
  assert.equal(toViewId('M-80 Lagoon/Trifid'), 'M_80_Lagoon_Trifid');
});

test('a leading digit is prefixed rather than dropped', () => {
  // Dropping it would turn 2808 and 4628 into the same view.
  assert.equal(toViewId('2808'), '_2808');
  assert.notEqual(toViewId('2808'), toViewId('4628'));
});

test('accents are folded, not replaced wholesale', () => {
  assert.equal(toViewId('Café'), 'Cafe');
  // A letter with no ASCII form becomes a separator rather than vanishing.
  assert.equal(toViewId('ω Centauri'), '_Centauri');
});

test('an underscore is part of the name, not padding to strip', () => {
  assert.equal(toViewId('_stars'), '_stars');
  assert.equal(toViewId('NGC_2808_stars'), 'NGC_2808_stars');
});

test('a name with nothing usable falls back rather than producing an empty id', () => {
  assert.equal(toViewId(''), 'Target');
  assert.equal(toViewId('!!!'), 'Target');
  assert.equal(toViewId(null), 'Target');
  assert.equal(toViewId(undefined, 'Fallback'), 'Fallback');
});

test('distinct targets stay distinct', () => {
  const names = ['NGC 2808', 'NGC 2809', 'M 31', 'M31', 'IC 4628'];
  const ids = names.map(n => toViewId(n));
  assert.equal(new Set(ids).size, names.length);
});
