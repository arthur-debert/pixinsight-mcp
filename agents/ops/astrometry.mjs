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

/**
 * Read whatever a view already knows about where it is pointing.
 * Returns { hasSolution, ra, dec, focalLengthMm, pixelSizeUm, object }.
 */
export async function readAstrometry(ctx, viewId) {
  const r = await ctx.pjsr(`
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
      hasSolution: w.astrometricSolution ? true : false,
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
 *   catalog        'GaiaDR3' (default), 'GaiaEDR3' or 'GaiaDR2'
 *   magnitude      limiting magnitude; omit to let the solver choose
 *   online         true to allow VizieR instead of a local Gaia database
 * @returns {{solved: boolean, detail: string, stars: number|null}}
 */
export async function plateSolve(ctx, viewId, opts = {}) {
  const {
    focalLengthMm = null,
    pixelSizeUm = null,
    catalog = 'GaiaDR3',
    magnitude = null,
    online = false,
  } = opts;

  const overrides = [];
  if (focalLengthMm) {
    overrides.push(`engine.metadata.focal = ${focalLengthMm};`);
    overrides.push(`engine.metadata.useFocal = true;`);
    // Resolution is derived from focal length and pixel size, so a stale value
    // would win over the focal length we just set.
    overrides.push(`engine.metadata.resolution = null;`);
  }
  if (pixelSizeUm) overrides.push(`engine.metadata.xpixsz = ${pixelSizeUm};`);
  if (magnitude) {
    overrides.push(`engine.solverCfg.magnitude = ${magnitude};`);
    overrides.push(`engine.solverCfg.autoMagnitude = false;`);
  }

  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('View not found: ${viewId}');

    var engine = new ImageSolver;
    engine.initialize(w, false);

    engine.solverCfg.catalogMode = ${online ? 'CatalogMode.Online' : 'CatalogMode.LocalXPSDServer'};
    engine.solverCfg.catalog = '${catalog}';
    engine.solverCfg.distortionCorrection = true;
    // Nothing is watching a dialog here, and the star overlays would leave
    // stray windows open in the middle of a pipeline.
    engine.solverCfg.showStars = false;
    engine.solverCfg.showStarMatches = false;
    engine.solverCfg.showDistortion = false;
    engine.solverCfg.generateErrorImg = false;
    ${overrides.join('\n    ')}

    var beforeFocal = engine.metadata.focal;
    var beforeRes = engine.metadata.resolution;
    var solved = engine.solveImage(w);

    JSON.stringify({
      solved: solved ? true : false,
      hasSolution: w.astrometricSolution ? true : false,
      stars: engine.numberOfDetectedStars || null,
      focal: beforeFocal,
      resolution: beforeRes,
      summary: w.astrometricSolution ? w.astrometricSolutionSummary().trim().split('\\n').slice(0, 6).join(' | ') : ''
    });
  `);

  if (r.status === 'error') {
    return { solved: false, stars: null, detail: r.error.message, consoleLog: r.error.consoleOutput || '' };
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
  const r = await ctx.pjsr(`
    var tgt = ImageWindow.windowById('${viewId}');
    if (tgt.isNull) throw new Error('View not found: ${viewId}');
    var opened = ImageWindow.open('${escaped}');
    if (opened.length === 0) throw new Error('Could not open ${escaped}');
    var src = opened[0];
    var copied = false;
    try {
      tgt.mainView.beginProcess();
      tgt.keywords = src.keywords;
      if (src.astrometricSolution) {
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
