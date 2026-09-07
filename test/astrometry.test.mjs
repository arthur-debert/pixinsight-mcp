// Plate solving is the one capability the V8 port lost and had to be rebuilt
// against a different API. These cover the parts that are decided on the Node
// side — which PJSR gets generated, and what happens when the solve fails —
// without needing PixInsight to run it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { plateSolve } from '../agents/ops/astrometry.mjs';

/** A bridge that records the PJSR it is handed and returns a canned result. */
function recordingCtx(results) {
  const sent = [];
  const queue = [...results];
  return {
    sent,
    pjsr: async code => {
      sent.push(code);
      return queue.shift() ?? { status: 'error', error: { message: 'no result queued' } };
    },
  };
}

const ok = payload => ({ status: 'ok', outputs: { consoleOutput: JSON.stringify(payload) } });
const fails = message => ({ status: 'error', error: { message } });

test('the generated PJSR has no unresolved template placeholders', async () => {
  const ctx = recordingCtx([ok({ hasSolution: true, stars: 300, focal: 3993 })]);
  await plateSolve(ctx, 'M13', { focalLengthMm: 3993, pixelSizeUm: 12 });
  assert.ok(!ctx.sent[0].includes('${'), ctx.sent[0].slice(0, 400));
});

test('supplied optics reach the solver, overriding the header defaults', async () => {
  const ctx = recordingCtx([ok({ hasSolution: true, stars: 300, focal: 3993 })]);
  await plateSolve(ctx, 'M13', { focalLengthMm: 3993, pixelSizeUm: 12 });
  assert.match(ctx.sent[0], /engine\.metadata\.focal = 3993/);
  assert.match(ctx.sent[0], /engine\.metadata\.xpixsz = 12/);
  // Resolution is derived from focal length and pixel size, so a stale value
  // would win over the focal length just set.
  assert.match(ctx.sent[0], /engine\.metadata\.resolution = null/);
});

test('with no catalogue named, the solver chooses for itself', async () => {
  // Automatic is what copes with an install that has no local Gaia database.
  const ctx = recordingCtx([ok({ hasSolution: true, stars: 300, focal: 1000 })]);
  await plateSolve(ctx, 'M13', {});
  assert.match(ctx.sent[0], /CatalogMode\.Automatic/);
});

test('a named catalogue is passed through verbatim', async () => {
  const ctx = recordingCtx([ok({ hasSolution: true, stars: 300, focal: 1000 })]);
  await plateSolve(ctx, 'M13', { catalog: 'GaiaDR3_XPSD' });
  assert.match(ctx.sent[0], /engine\.solverCfg\.catalog = 'GaiaDR3_XPSD'/);
});

test('a singular distortion fit is retried without distortion correction', async () => {
  // A dense field gives the solver thousands of clustered sources, and fitting a
  // distortion spline through those is degenerate. The linear solution still
  // gives SPCC everything it needs.
  const ctx = recordingCtx([
    fails('Matrix.inverse(): Singular matrix.'),
    ok({ hasSolution: true, stars: 412, focal: 3993 }),
  ]);
  const r = await plateSolve(ctx, 'NGC_2808', { focalLengthMm: 3993, pixelSizeUm: 12 });

  assert.equal(ctx.sent.length, 2);
  assert.match(ctx.sent[0], /distortionCorrection = true/);
  assert.match(ctx.sent[1], /distortionCorrection = false/);
  assert.equal(r.solved, true);
  assert.match(r.detail, /linear solution/);
});

test('a failure that is not a singular matrix is not retried', async () => {
  const ctx = recordingCtx([fails('Insufficient stars detected: found 3')]);
  const r = await plateSolve(ctx, 'M13', {});
  assert.equal(ctx.sent.length, 1, 'retrying a star-count failure would just waste a minute');
  assert.equal(r.solved, false);
});

test('an unresolvable catalogue failure explains the suffix', async () => {
  // The solver reports it as a null-property assignment, frames away from the
  // name that could not be resolved.
  const ctx = recordingCtx([fails("Cannot set properties of null (setting 'magMax')")]);
  const r = await plateSolve(ctx, 'M13', { catalog: 'GaiaDR3' });
  assert.equal(r.solved, false);
  assert.match(r.detail, /GaiaDR3_XPSD/);
});

test('a solve that reports success but writes no solution is not called solved', async () => {
  const ctx = recordingCtx([ok({ solved: true, hasSolution: false, stars: 40, focal: 1000 })]);
  const r = await plateSolve(ctx, 'M13', {});
  assert.equal(r.solved, false);
});
