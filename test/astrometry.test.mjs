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
});

test('image scale is computed, never left for the solver to derive', async () => {
  // This is the one that cost three minutes per failed solve. The solver sizes
  // its catalogue query from metadata.resolution and does NOT recompute it from
  // focal length, so leaving it null means a zero-size field, zero catalogue
  // stars, and a "Matrix.inverse(): Singular matrix" several frames later that
  // names nothing that led to it.
  const ctx = recordingCtx([ok({ hasSolution: true, stars: 300, focal: 3993 })]);
  await plateSolve(ctx, 'M13', { focalLengthMm: 3993, pixelSizeUm: 12 });

  assert.doesNotMatch(ctx.sent[0], /engine\.metadata\.resolution = null/);
  const m = /engine\.metadata\.resolution = ([\d.e-]+);/.exec(ctx.sent[0]);
  assert.ok(m, 'resolution must be set explicitly');

  // 206.265 * 12um / 3993mm = 0.6199 arcsec/px, and resolution is in degrees.
  const degPerPx = Number(m[1]);
  assert.ok(degPerPx > 0, `resolution must be positive, got ${degPerPx}`);
  assert.ok(Math.abs(degPerPx * 3600 - 0.6199) < 0.001,
    `expected ~0.6199 arcsec/px, got ${(degPerPx * 3600).toFixed(4)}`);
});

test('an explicit image scale wins over the optics', async () => {
  const ctx = recordingCtx([ok({ hasSolution: true, stars: 300, focal: 0 })]);
  await plateSolve(ctx, 'M13', { focalLengthMm: 1000, pixelSizeUm: 9, resolutionArcsecPerPx: 0.62 });
  const m = /engine\.metadata\.resolution = ([\d.e-]+);/.exec(ctx.sent[0]);
  assert.ok(Math.abs(Number(m[1]) * 3600 - 0.62) < 0.0001);
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

test('a failure about the inputs is not retried', async () => {
  // Retrying a star-count failure just spends another minute on the same answer.
  const ctx = recordingCtx([fails('Insufficient stars detected: found 3')]);
  const r = await plateSolve(ctx, 'M13', {});
  assert.equal(ctx.sent.length, 1);
  assert.equal(r.solved, false);
});

test('a quiet non-solution is retried without distortion correction', async () => {
  // A failing distortion fit on a dense field does not always raise. It can also
  // return having written no solution at all, which looked like a clean failure
  // and skipped the retry that would have worked.
  const ctx = recordingCtx([
    ok({ solved: false, hasSolution: false, stars: 7222, focal: 3993 }),
    ok({ solved: true, hasSolution: true, stars: 3558, focal: 3993 }),
  ]);
  const r = await plateSolve(ctx, 'NGC_2808', { focalLengthMm: 3993, pixelSizeUm: 12 });
  assert.equal(ctx.sent.length, 2, 'a quiet non-solution deserves the linear retry');
  assert.match(ctx.sent[1], /distortionCorrection = false/);
  assert.equal(r.solved, true);
});

test('an unresolvable catalogue failure explains the suffix', async () => {
  // The solver reports it as a null-property assignment, frames away from the
  // name that could not be resolved.
  // Both attempts fail the same way: a catalogue that cannot be resolved is not
  // something the linear retry can fix, but the retry still runs.
  const bad = "Cannot set properties of null (setting 'magMax')";
  const ctx = recordingCtx([fails(bad), fails(bad)]);
  const r = await plateSolve(ctx, 'M13', { catalog: 'GaiaDR3' });
  assert.equal(r.solved, false);
  assert.match(r.detail, /GaiaDR3_XPSD/);
});

test('a solve that reports success but writes no solution is not called solved', async () => {
  const ctx = recordingCtx([ok({ solved: true, hasSolution: false, stars: 40, focal: 1000 })]);
  const r = await plateSolve(ctx, 'M13', {});
  assert.equal(r.solved, false);
});
