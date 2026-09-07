// ============================================================================
// Image management: clone, restore, close, purge
// ============================================================================

/**
 * Turn an arbitrary target name into a valid PixInsight view identifier.
 *
 * View ids follow C identifier rules: letters, digits and underscores, never
 * starting with a digit. Passing anything else to ImageWindow.windowById()
 * throws under the V8 runtime — with the message "undefined" and no other
 * detail — so a target called "NGC 2808" takes down every step that touches its
 * view, several stages after the name was set.
 */
export function toViewId(name, fallback = 'Target') {
  const cleaned = String(name ?? '')
    .trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // fold accents
    .replace(/[^A-Za-z0-9_]+/g, '_');
  // Underscores are legal and meaningful — "_stars" is a name this pipeline
  // uses — so only a result with nothing else in it falls back.
  if (!cleaned || /^_+$/.test(cleaned)) return fallback;
  return /^[0-9]/.test(cleaned) ? '_' + cleaned : cleaned;
}

/**
 * Clone an open image to a new hidden window (in-memory, no disk I/O).
 */
export async function cloneImage(ctx, sourceId, cloneId) {
  const dimR = await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${sourceId}');
    if (srcW.isNull) throw new Error('Clone source not found: ${sourceId}');
    var img = srcW.mainView.image;
    JSON.stringify({ w: img.width, h: img.height, ch: img.numberOfChannels, color: img.isColor });
  `);
  if (dimR.status === 'error') throw new Error('cloneImage: ' + dimR.error.message);
  const d = JSON.parse(dimR.outputs?.consoleOutput?.trim() || '{}');

  const r = await ctx.pjsr(`
    var old = ImageWindow.windowById('${cloneId}');
    if (!old.isNull) old.forceClose();
    var srcW = ImageWindow.windowById('${sourceId}');
    var clone = new ImageWindow(${d.w || 0}, ${d.h || 0}, ${d.ch || 3}, 32, true, ${d.color !== false}, '${cloneId}');
    clone.mainView.beginProcess();
    clone.mainView.image.assign(srcW.mainView.image);
    clone.mainView.endProcess();
    clone.hide();
    'OK';
  `);
  if (r.status === 'error') throw new Error('cloneImage: ' + r.error.message);
}

/**
 * Restore target image from a clone (in-memory copy).
 */
export async function restoreFromClone(ctx, targetId, cloneId) {
  const r = await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${targetId}');
    var clone = ImageWindow.windowById('${cloneId}');
    if (srcW.isNull) throw new Error('Restore target not found: ${targetId}');
    if (clone.isNull) throw new Error('Clone not found: ${cloneId}');
    srcW.mainView.beginProcess();
    srcW.mainView.image.assign(clone.mainView.image);
    srcW.mainView.endProcess();
    'OK';
  `);
  if (r.status === 'error') throw new Error('restoreFromClone: ' + r.error.message);
}

/**
 * Close an image window.
 */
export async function closeImage(ctx, viewId) {
  await ctx.pjsr(`var w = ImageWindow.windowById('${viewId}'); if (!w.isNull) w.forceClose();`);
}

/**
 * Purge undo history for a view to free memory.
 */
export async function purgeUndoHistory(ctx, viewId) {
  await ctx.pjsr(`var w = ImageWindow.windowById('${viewId}'); if (!w.isNull) w.purge();`);
}
