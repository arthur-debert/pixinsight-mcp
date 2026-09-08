// ============================================================================
// Filter transmission and sensor QE curves, read from PixInsight's own database
// ============================================================================
//
// SPCC takes both a NAME and a CURVE for each channel, and it applies the curve.
// The name is a label. This repo used to pass hardcoded Astronomik Deep Sky
// curves and a Sony IMX571 QE curve while letting equipment.json set the names,
// so configuring "Astrodon E-series" produced Astronomik numbers under an
// Astrodon label — a calibration that looks authoritative and is wrong.
//
// PixInsight ships the real curves in library/filters.xspd, the same database
// the SPCC interface offers. Reading them from there means the name and the
// curve can never disagree, and any rig the application knows about is usable
// without editing this repo.

import fs from 'fs';
import path from 'path';

const DEFAULT_DB = '/Applications/PixInsight/library/filters.xspd';

let cache = null;

function loadDatabase(dbPath = DEFAULT_DB) {
  if (cache && cache.path === dbPath) return cache.entries;
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Filter database not found at ${dbPath}. Is PixInsight installed here?`);
  }
  const xml = fs.readFileSync(dbPath, 'utf-8');
  const entries = new Map();
  // <Filter name="..." channel="..." data="wavelength,transmission,..."/>
  for (const m of xml.matchAll(/<Filter\b([^>]*)>/g)) {
    const attrs = m[1];
    const name = /name="([^"]*)"/.exec(attrs)?.[1];
    const data = /data="([^"]*)"/.exec(attrs)?.[1];
    if (name && data) entries.set(name, data);
  }
  cache = { path: dbPath, entries };
  return entries;
}

/** Every curve name the installed PixInsight knows about. */
export function listCurves(dbPath = DEFAULT_DB) {
  return [...loadDatabase(dbPath).keys()].sort();
}

/**
 * The transmission or QE curve for a named entry, as the comma-separated
 * wavelength/value string SPCC expects.
 *
 * Throws rather than falling back. A silently substituted curve is the failure
 * this module exists to prevent.
 */
export function loadCurve(name, dbPath = DEFAULT_DB) {
  const entries = loadDatabase(dbPath);
  const curve = entries.get(name);
  if (!curve) {
    const near = [...entries.keys()]
      .filter(k => k.toLowerCase().includes(String(name).toLowerCase().split(/\s+/)[0] ?? ''))
      .slice(0, 8);
    throw new Error(
      `No curve named "${name}" in ${dbPath}.` +
      (near.length ? ` Did you mean: ${near.join(', ')}?` : ` Run listCurves() to see what is available.`));
  }
  return curve;
}

/**
 * Resolve an SPCC configuration into the names and curves the process needs.
 *
 * @param {object} spcc - { filterSet, sensorQE, whiteReference }
 *   filterSet names a set whose members are "<set> R", "<set> G", "<set> B",
 *   which is how the database is organised.
 */
export function resolveSpccCurves(spcc, dbPath = DEFAULT_DB) {
  const { filterSet, sensorQE, whiteReference = 'Average Spiral Galaxy' } = spcc;
  if (!filterSet) throw new Error('spcc.filterSet is required');
  if (!sensorQE) throw new Error('spcc.sensorQE is required');

  const names = { red: `${filterSet} R`, green: `${filterSet} G`, blue: `${filterSet} B` };
  return {
    filterSet,
    sensorQE,
    whiteReference,
    names,
    red: loadCurve(names.red, dbPath),
    green: loadCurve(names.green, dbPath),
    blue: loadCurve(names.blue, dbPath),
    qe: loadCurve(sensorQE, dbPath),
  };
}
