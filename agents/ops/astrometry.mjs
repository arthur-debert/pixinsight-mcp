// ============================================================================
// Astrometry: plate solving and astrometric solution transfer
// ============================================================================
//
// The solver runs inside the watcher, which includes ImageSolverEngine.js from
// PixInsight's own scripts directory. That engine is a class, not a process:
//
//   let engine = new ImageSolver;
//   engine.initialize( window, false );
//   engine.solveImage( window );
//
// It needs a starting point — sky position and image scale — which it reads
// from the image's FITS keywords. Stacked masters routinely lack FOCALLEN even
// when they carry RA and DEC, and the engine then falls back to 1000mm with
// 7.4µm pixels. Those defaults are wrong for most rigs by enough that the solve
// fails outright, so the caller can supply the real optics.

// PixInsight 1.9.4 removed ImageWindow.astrometricSolution. Reading it yields
// undefined rather than throwing, so every check written against it reports "no
// solution" whether or not one exists — which is why plate solving appeared to
// fail here for a day while it was in fact succeeding, and why SPCC was skipped
// on every run. astrometricSolutionSummary() is the accessor that still works.
const HAS_SOLUTION_FN = `
    function hasAstrometricSolution(w) {
      try {
        var s = w.astrometricSolutionSummary();
        return !!(s && s.length > 0);
      } catch (e) {
        return false;
      }
    }`;

/**
 * Read whatever a view already knows about where it is pointing.
 * Returns { hasSolution, ra, dec, focalLengthMm, pixelSizeUm, object }.
 */
export async function readAstrometry(ctx, viewId) {
  const r = await ctx.pjsr(`${HAS_SOLUTION_FN}
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('View not found: ${viewId}');
    var kw = w.keywords, found = {};
    for (var i = 0; i < kw.length; ++i) {
      var name = kw[i].name;
      var value = String(kw[i].value).replace(/^'|'$/g, "").trim();
      if (name === 'RA' || name === 'DEC' || name === 'FOCALLEN' ||
          name === 'XPIXSZ' || name === 'PIXSIZE' || name === 'OBJECT' ||
          name === 'OBJCTRA' || name === 'OBJCTDEC')
        found[name] = value;
    }
    JSON.stringify({
      hasSolution: hasAstrometricSolution(w),
      keywords: found
    });
  `);
  if (r.status === 'error') throw new Error('readAstrometry: ' + r.error.message);
  const parsed = JSON.parse((r.outputs?.consoleOutput || '{}').trim());
  const kw = parsed.keywords || {};
  const num = v => (v === undefined || v === '' ? null : Number(v));
  return {
    hasSolution: !!parsed.hasSolution,
    ra: num(kw.RA),
    dec: num(kw.DEC),
    focalLengthMm: num(kw.FOCALLEN),
    pixelSizeUm: num(kw.XPIXSZ) ?? num(kw.PIXSIZE),
    object: kw.OBJECT ?? null,
  };
}

/**
 * Plate solve a view, writing an astrometric solution into its window.
 *
 * @param {object} opts
 *   focalLengthMm  telescope focal length; overrides FOCALLEN when given
 *   pixelSizeUm    sensor pixel pitch; overrides XPIXSZ when given
 *   catalog        force a catalogue by its registry name — "GaiaDR3_XPSD",
 *                  "GaiaEDR3_XPSD", "GaiaDR2_XPSD", "GaiaDR2", "TYCHO-2" or
 *                  "Bright Stars". Omit it: the solver's automatic mode picks a
 *                  local Gaia database when one is installed and an online
 *                  catalogue sized to the field of view when none is.
 *   magnitude      limiting magnitude; omit to let the solver choose
 *   online         true to force VizieR rather than a local Gaia database
 * @returns {{solved: boolean, detail: string, stars: number|null}}
 */
export async function plateSolve(ctx, viewId, opts = {}) {
  const {
    focalLengthMm = null,
    pixelSizeUm = null,
    catalog = null,
    magnitude = null,
    online = false,
    resolutionArcsecPerPx = null,
  } = opts;

  // A dense field — a globular cluster above all — gives the solver thousands of
  // blended, clustered sources. Fitting a distortion spline through those
  // produces degenerate correspondences and the solve dies on
  // "Matrix.inverse(): Singular matrix". Dropping to a linear solution recovers
  // it, at the cost of not modelling optical distortion, which SPCC does not
  // need. So: try with distortion correction, and fall back without it.
  const first = await attemptSolve(ctx, viewId, { focalLengthMm, pixelSizeUm, catalog, magnitude, online,
                                                 resolutionArcsecPerPx, distortionCorrection: true });

  // A failing distortion fit does not always raise: on a dense field it can also
  // return quietly having written no solution. Both are worth one linear retry.
  // The failures a retry cannot help are the ones about the inputs rather than
  // the fit, and repeating those just spends another minute reaching the same
  // answer.
  const notWorthRetrying = /Insufficient stars|no sky position|Image scale is zero|View not found/;
  if (first.solved || notWorthRetrying.test(first.detail ?? '')) {
    return first;
  }

  const second = await attemptSolve(ctx, viewId, { focalLengthMm, pixelSizeUm, catalog, magnitude, online,
                                                   resolutionArcsecPerPx, distortionCorrection: false });
  return second.solved
    ? { ...second, detail: `${second.detail} (linear solution; the distortion fit was singular on this field)` }
    : { ...second, detail: `${second.detail} — and the distortion fit was singular before that` };
}

async function attemptSolve(ctx, viewId, opts) {
  const { focalLengthMm, pixelSizeUm, catalog, magnitude, online, distortionCorrection,
          resolutionArcsecPerPx } = opts;

  const overrides = [];
  if (pixelSizeUm) overrides.push(`engine.metadata.xpixsz = ${pixelSizeUm};`);
  if (focalLengthMm) {
    overrides.push(`engine.metadata.focal = ${focalLengthMm};`);
    overrides.push(`engine.metadata.useFocal = true;`);
  }

  // Image scale is what the solver actually searches with, and it does NOT
  // derive it from focal length at solve time. Leaving it null means a scale of
  // zero, a zero-size search field, and a catalogue query that returns nothing —
  // which then surfaces several frames later as "Matrix.inverse(): Singular
  // matrix", naming nothing that led to it. So compute it here.
  //
  // resolution is in DEGREES per pixel; arcsec/px = 206.265 * pixelSize(um) / focal(mm).
  const arcsecPerPx = resolutionArcsecPerPx
    ?? ((focalLengthMm && pixelSizeUm) ? (206.265 * pixelSizeUm / focalLengthMm) : null);
  if (arcsecPerPx) {
    overrides.push(`engine.metadata.resolution = ${arcsecPerPx / 3600};`);
    overrides.push(`engine.metadata.useFocal = false;`);
  }
  if (magnitude) {
    overrides.push(`engine.solverCfg.magnitude = ${magnitude};`);
    overrides.push(`engine.solverCfg.autoMagnitude = false;`);
  }

  const r = await ctx.pjsr(`${HAS_SOLUTION_FN}
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('View not found: ${viewId}');

    var engine = new ImageSolver;
    engine.initialize(w, false);

    // Automatic is the mode that copes with an install that has no local Gaia
    // database: it falls back to an online catalogue chosen for the field of
    // view. Naming a catalogue explicitly needs its registry name — a plain
    // "GaiaDR3" resolves to null and the solver then fails on a null catalogue.
    engine.solverCfg.catalogMode = ${
      catalog ? 'CatalogMode.LocalXPSDServer'
              : online ? 'CatalogMode.Online'
                       : 'CatalogMode.Automatic'};
    ${catalog ? `engine.solverCfg.catalog = '${catalog}';` : ''}
    engine.solverCfg.distortionCorrection = ${distortionCorrection};
    // Nothing is watching a dialog here, and the star overlays would leave
    // stray windows open in the middle of a pipeline.
    engine.solverCfg.showStars = false;
    engine.solverCfg.showStarMatches = false;
    engine.solverCfg.showDistortion = false;
    engine.solverCfg.generateErrorImg = false;
    ${overrides.join('\n    ')}

    if (!engine.metadata.resolution || engine.metadata.resolution <= 0) {
      throw new Error(
        "Image scale is zero. The solver searches a field sized by metadata.resolution, " +
        "so a zero scale queries an empty region and reports the failure much later as a " +
        "singular matrix. Supply focalLengthMm with pixelSizeUm, or resolutionArcsecPerPx.");
    }
    if (engine.metadata.ra === null || engine.metadata.dec === null) {
      throw new Error(
        "The image carries no sky position. Plate solving needs RA and DEC " +
        "keywords (or OBJCTRA/OBJCTDEC) to start from.");
    }

    var beforeFocal = engine.metadata.focal;
    var beforeRes = engine.metadata.resolution;
    var solved = engine.solveImage(w);

    JSON.stringify({
      solved: solved ? true : false,
      hasSolution: hasAstrometricSolution(w),
      stars: engine.numberOfDetectedStars || null,
      focal: beforeFocal,
      resolution: beforeRes,
      summary: hasAstrometricSolution(w) ? w.astrometricSolutionSummary().trim().split('\\n').slice(0, 6).join(' | ') : ''
    });
  `);

  if (r.status === 'error') {
    const message = r.error.message;
    // The solver reports a missing catalogue as a null-property assignment,
    // several frames away from the name that could not be resolved.
    const hint = /setting 'magMax'|Catalog error/.test(message)
      ? ' The catalogue could not be resolved. Registry names carry a suffix — ' +
        '"GaiaDR3_XPSD", not "GaiaDR3" — or omit the catalog option entirely and ' +
        'let the solver choose.'
      : '';
    return { solved: false, stars: null, detail: message + hint, consoleLog: r.error.consoleOutput || '' };
  }
  const out = JSON.parse((r.outputs?.consoleOutput || '{}').trim());
  return {
    solved: !!out.hasSolution,
    stars: out.stars,
    detail: out.hasSolution
      ? `solved with ${out.stars} stars (focal ${out.focal}mm)`
      : `no solution (${out.stars ?? 0} stars detected, focal ${out.focal}mm)`,
    summary: out.summary || '',
  };
}

/**
 * Copy an astrometric solution from a file on disk onto an open view.
 *
 * Stacking often drops the WCS that individual calibrated frames carry, and
 * BlurXTerminator strips it outright, so recovering it from a source file is
 * cheaper and more reliable than solving again.
 */
export async function copyAstrometryFromFile(ctx, viewId, sourcePath) {
  const escaped = sourcePath.replace(/'/g, "\\'");
  const r = await ctx.pjsr(`${HAS_SOLUTION_FN}
    var tgt = ImageWindow.windowById('${viewId}');
    if (tgt.isNull) throw new Error('View not found: ${viewId}');
    var opened = ImageWindow.open('${escaped}');
    if (opened.length === 0) throw new Error('Could not open ${escaped}');
    var src = opened[0];
    var copied = false;
    try {
      tgt.mainView.beginProcess();
      tgt.keywords = src.keywords;
      if (hasAstrometricSolution(src)) {
        tgt.copyAstrometricSolution(src, false);
        copied = true;
      }
      tgt.mainView.endProcess();
    } finally {
      src.forceClose();
      // Opening an XISF brings its crop mask along; left open, those windows
      // accumulate through a run and confuse every later view lookup.
      var ws = ImageWindow.windows;
      for (var i = 0; i < ws.length; ++i)
        if (ws[i].mainView.id.indexOf('crop_mask') >= 0) ws[i].forceClose();
    }
    copied ? 'COPIED' : 'NO_SOLUTION_IN_SOURCE';
  `);
  if (r.status === 'error') throw new Error('copyAstrometryFromFile: ' + r.error.message);
  return (r.outputs?.consoleOutput || '').includes('COPIED');
}
