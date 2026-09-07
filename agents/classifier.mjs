// ============================================================================
// Classifier / Intent Agent
// Determines target classification and generates processing brief.
// Rule-based for Phase 1 (LLM-based classification in Phase 2).
// ============================================================================
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load processing profiles from JSON.
 */
function loadProcessingProfiles() {
  const profilePath = path.join(__dirname, 'processing-profiles.json');
  if (fs.existsSync(profilePath)) {
    return JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
  }
  return {};
}

/**
 * Load target taxonomy from JSON.
 */
function loadTaxonomy() {
  const taxPath = path.join(__dirname, 'target-taxonomy.json');
  if (fs.existsSync(taxPath)) {
    return JSON.parse(fs.readFileSync(taxPath, 'utf-8')).categories || {};
  }
  return {};
}

/**
 * Catalogue designations and their classifications.
 *
 * Keys are normalised designations: catalogue prefix plus number, no spaces or
 * punctuation. They are matched against designations extracted from the target
 * name, never as substrings of it — "M2" must not classify M20, and "NGC104"
 * must not classify NGC1042.
 */
const KNOWN_OBJECTS = {
  // Spiral galaxies
  M31: 'galaxy_spiral', M33: 'galaxy_spiral', M51: 'galaxy_spiral',
  M63: 'galaxy_spiral', M64: 'galaxy_spiral', M65: 'galaxy_spiral',
  M66: 'galaxy_spiral', M74: 'galaxy_spiral', M81: 'galaxy_spiral',
  M82: 'galaxy_spiral', M83: 'galaxy_spiral', M94: 'galaxy_spiral',
  M99: 'galaxy_spiral', M100: 'galaxy_spiral', M101: 'galaxy_spiral',
  M104: 'galaxy_spiral', M106: 'galaxy_spiral', M108: 'galaxy_spiral',
  M109: 'galaxy_spiral',
  NGC253: 'galaxy_spiral', NGC300: 'galaxy_spiral', NGC1300: 'galaxy_spiral',
  NGC2403: 'galaxy_spiral', NGC2903: 'galaxy_spiral', NGC3628: 'galaxy_spiral',
  NGC4490: 'galaxy_spiral', NGC5033: 'galaxy_spiral', NGC6946: 'galaxy_spiral',
  NGC7331: 'galaxy_spiral',

  // Edge-on galaxies
  NGC891: 'galaxy_edge_on', NGC4244: 'galaxy_edge_on', NGC4565: 'galaxy_edge_on',
  NGC4631: 'galaxy_edge_on', NGC5907: 'galaxy_edge_on', NGC55: 'galaxy_edge_on',

  // Elliptical galaxies
  M49: 'galaxy_elliptical', M60: 'galaxy_elliptical', M84: 'galaxy_elliptical',
  M86: 'galaxy_elliptical', M87: 'galaxy_elliptical', M105: 'galaxy_elliptical',
  NGC5128: 'galaxy_elliptical',

  // Galaxy clusters and groups
  ABELL1656: 'galaxy_cluster', ABELL2151: 'galaxy_cluster', ABELL426: 'galaxy_cluster',
  HCG92: 'galaxy_cluster',

  // Emission nebulae
  M8: 'emission_nebula', M16: 'emission_nebula', M17: 'emission_nebula',
  M20: 'emission_nebula', M42: 'emission_nebula', M43: 'emission_nebula',
  NGC281: 'emission_nebula', NGC1499: 'emission_nebula', NGC2024: 'emission_nebula',
  NGC2070: 'emission_nebula', NGC2237: 'emission_nebula', NGC2244: 'emission_nebula',
  NGC3372: 'emission_nebula', NGC6357: 'emission_nebula', NGC6820: 'emission_nebula',
  NGC6888: 'emission_nebula', NGC7000: 'emission_nebula', NGC7380: 'emission_nebula',
  NGC7635: 'emission_nebula',
  IC1396: 'emission_nebula', IC1805: 'emission_nebula', IC1848: 'emission_nebula',
  IC2944: 'emission_nebula', IC4628: 'emission_nebula', IC5070: 'emission_nebula',
  IC410: 'emission_nebula', IC434: 'emission_nebula', IC443: 'supernova_remnant',

  // Reflection nebulae
  M45: 'reflection_nebula',
  NGC1333: 'reflection_nebula', NGC7023: 'reflection_nebula', IC2118: 'reflection_nebula',

  // Planetary nebulae
  M27: 'planetary_nebula', M57: 'planetary_nebula', M76: 'planetary_nebula',
  M97: 'planetary_nebula',
  NGC2392: 'planetary_nebula', NGC3242: 'planetary_nebula', NGC3132: 'planetary_nebula',
  NGC6543: 'planetary_nebula', NGC6826: 'planetary_nebula', NGC7009: 'planetary_nebula',
  NGC7293: 'planetary_nebula',

  // Supernova remnants
  M1: 'supernova_remnant',
  NGC6960: 'supernova_remnant', NGC6979: 'supernova_remnant', NGC6992: 'supernova_remnant',
  NGC6995: 'supernova_remnant', SIMEIS147: 'supernova_remnant',

  // Globular clusters
  M2: 'star_cluster_globular', M3: 'star_cluster_globular', M4: 'star_cluster_globular',
  M5: 'star_cluster_globular', M10: 'star_cluster_globular', M12: 'star_cluster_globular',
  M13: 'star_cluster_globular', M15: 'star_cluster_globular', M19: 'star_cluster_globular',
  M22: 'star_cluster_globular', M53: 'star_cluster_globular', M55: 'star_cluster_globular',
  M62: 'star_cluster_globular', M68: 'star_cluster_globular', M72: 'star_cluster_globular',
  M79: 'star_cluster_globular', M80: 'star_cluster_globular', M92: 'star_cluster_globular',
  NGC104: 'star_cluster_globular', NGC288: 'star_cluster_globular',
  NGC362: 'star_cluster_globular', NGC1851: 'star_cluster_globular',
  NGC2808: 'star_cluster_globular', NGC3201: 'star_cluster_globular',
  NGC5139: 'star_cluster_globular', NGC5286: 'star_cluster_globular',
  NGC6397: 'star_cluster_globular', NGC6541: 'star_cluster_globular',
  NGC6752: 'star_cluster_globular', NGC7099: 'star_cluster_globular',

  // Open clusters
  M6: 'star_cluster_open', M7: 'star_cluster_open', M11: 'star_cluster_open',
  M34: 'star_cluster_open', M35: 'star_cluster_open', M36: 'star_cluster_open',
  M37: 'star_cluster_open', M38: 'star_cluster_open', M39: 'star_cluster_open',
  M41: 'star_cluster_open', M44: 'star_cluster_open', M46: 'star_cluster_open',
  M47: 'star_cluster_open', M48: 'star_cluster_open', M50: 'star_cluster_open',
  M52: 'star_cluster_open', M67: 'star_cluster_open', M93: 'star_cluster_open',
  NGC752: 'star_cluster_open', NGC869: 'star_cluster_open', NGC884: 'star_cluster_open',
  NGC2264: 'star_cluster_open', NGC3114: 'star_cluster_open', NGC3532: 'star_cluster_open',
  NGC4755: 'star_cluster_open', NGC6231: 'star_cluster_open', IC2602: 'star_cluster_open',
  IC4665: 'star_cluster_open',

  // Dark nebulae
  BARNARD33: 'dark_nebula', BARNARD68: 'dark_nebula', BARNARD72: 'dark_nebula',
  LDN1622: 'dark_nebula',
};

/**
 * Common names, for targets more often named than catalogued. Matched as whole
 * words against the target name.
 */
const KNOWN_NAMES = {
  'andromeda': 'galaxy_spiral',
  'bode': 'galaxy_spiral',
  'cigar': 'galaxy_spiral',
  'pinwheel': 'galaxy_spiral',
  'sculptor': 'galaxy_spiral',
  'sombrero': 'galaxy_spiral',
  'whirlpool': 'galaxy_spiral',
  'needle': 'galaxy_edge_on',
  'centaurus a': 'galaxy_elliptical',
  'hercules cluster': 'galaxy_cluster',
  'stephan': 'galaxy_cluster',
  'carina': 'emission_nebula',
  'cone': 'emission_nebula',
  'crescent': 'emission_nebula',
  'eagle': 'emission_nebula',
  'elephant': 'emission_nebula',
  'flame': 'emission_nebula',
  'heart': 'emission_nebula',
  'lagoon': 'emission_nebula',
  'north america': 'emission_nebula',
  'orion': 'emission_nebula',
  'pelican': 'emission_nebula',
  'prawn': 'emission_nebula',
  'rosette': 'emission_nebula',
  'rosetta': 'emission_nebula',
  'soul': 'emission_nebula',
  'swan': 'emission_nebula',
  'tarantula': 'emission_nebula',
  'trifid': 'emission_nebula',
  'bubble': 'emission_nebula',
  'iris': 'reflection_nebula',
  'pleiades': 'reflection_nebula',
  'witch head': 'reflection_nebula',
  'dumbbell': 'planetary_nebula',
  'helix': 'planetary_nebula',
  'owl': 'planetary_nebula',
  'ring': 'planetary_nebula',
  'saturn nebula': 'planetary_nebula',
  'crab': 'supernova_remnant',
  'veil': 'supernova_remnant',
  'horsehead': 'dark_nebula',
  'omega centauri': 'star_cluster_globular',
  'tucana': 'star_cluster_globular',
  '47 tuc': 'star_cluster_globular',
  'double cluster': 'star_cluster_open',
  'beehive': 'star_cluster_open',
  'jewel box': 'star_cluster_open',
  'wild duck': 'star_cluster_open',
};

/**
 * Pull catalogue designations out of a target name.
 * "NGC-2808", "ngc 2808", "NGC_2808_LRGB" all yield "NGC2808".
 */
function extractDesignations(name) {
  const compact = name.replace(/[\s_-]+/g, '').toUpperCase();
  const pattern = /(M|NGC|IC|ABELL|BARNARD|LDN|SH2|VDB|HCG|SIMEIS)(\d+)/g;
  return [...compact.matchAll(pattern)].map(m => m[1] + m[2]);
}

/**
 * Classify a target from its name.
 *
 * Returns null when nothing matches, rather than guessing. mixed_field is a real
 * category — targets like Rho Ophiuchi genuinely belong there — so silently
 * defaulting to it hides unknown targets among deliberate ones, and the whole
 * processing brief is built from the category.
 */
function classifyFromName(name) {
  for (const designation of extractDesignations(name)) {
    if (KNOWN_OBJECTS[designation]) return KNOWN_OBJECTS[designation];
  }

  const lower = name.toLowerCase();
  for (const [term, cls] of Object.entries(KNOWN_NAMES)) {
    if (new RegExp(`\\b${term}\\b`).test(lower)) return cls;
  }

  // Folder names run words together — "NGC-6990-TheVeil" has no word boundary
  // before "veil". Fall back to a substring match on the compacted name, but
  // only for terms long enough that an accidental match is unlikely.
  const compact = lower.replace(/[^a-z0-9]/g, '');
  for (const [term, cls] of Object.entries(KNOWN_NAMES)) {
    const compactTerm = term.replace(/[^a-z0-9]/g, '');
    if (compactTerm.length >= 4 && compact.includes(compactTerm)) return cls;
  }

  // Last resort: the object-type word people put in folder names. "cluster"
  // alone is ambiguous between globular, open and galaxy cluster, so it only
  // classifies when qualified.
  if (/\bglobular\b/i.test(name)) return 'star_cluster_globular';
  if (/\bopen cluster\b/i.test(name)) return 'star_cluster_open';
  if (/\bgalaxy cluster\b/i.test(name)) return 'galaxy_cluster';
  if (/\bplanetary\b/i.test(name)) return 'planetary_nebula';
  if (/\bdark nebula\b/i.test(name)) return 'dark_nebula';
  if (/\bremnant\b/i.test(name)) return 'supernova_remnant';
  if (/\bgalaxy\b/i.test(name)) return 'galaxy_spiral';
  if (/\bnebula\b/i.test(name)) return 'emission_nebula';

  return null;
}

/**
 * Determine workflow type from the channels the config actually provides.
 */
function detectWorkflow(config) {
  const F = config.files;
  const has = k => !!(F[k] && F[k].trim());
  const hasRGB = has('R') && has('G') && has('B');

  if (!hasRGB && has('L')) return 'L_only';
  if (has('L') && has('Ha') && hasRGB) return 'HaLRGB';
  if (has('Ha') && hasRGB) return 'HaRGB';
  if (has('L') && hasRGB) return 'LRGB';
  return 'RGB';
}

/**
 * Generate a processing brief from a pipeline config and optional user intent.
 * @param {object} config - Pipeline config (v2 JSON)
 * @param {object} opts - { intent, style, ... }
 * @returns {object} Processing brief
 */
export function generateBrief(config, opts = {}) {
  const targetName = config.files?.targetName || config.name || 'Unknown';
  const taxonomy = loadTaxonomy();

  const matched = opts.classification || classifyFromName(targetName);
  // An unmatched name still has to process, but it must not silently pass as a
  // deliberate mixed_field: every trait in the brief comes from the category, so
  // a wrong one steers the whole run.
  const classification = matched ?? 'mixed_field';
  const classificationSource = opts.classification ? 'caller'
    : matched ? 'name' : 'fallback';
  if (!taxonomy[classification]) {
    throw new Error(
      `Classification "${classification}" for target "${targetName}" is not in ` +
      `target-taxonomy.json. Known categories: ${Object.keys(taxonomy).join(', ')}.`);
  }

  const workflow = detectWorkflow(config);
  const isGalaxy = classification.startsWith('galaxy');

  // Determine aesthetic intent
  const style = opts.style || 'enhanced_natural';
  const backgroundTarget = isGalaxy ? 'dark' : 'medium';

  // Set technical priorities based on target class
  let priorities;
  if (isGalaxy) {
    priorities = ['signal_preservation', 'dynamic_range', 'resolution', 'noise_control',
      'background_quality', 'natural_appearance', 'color_accuracy', 'star_quality'];
  } else if (classification === 'emission_nebula') {
    priorities = ['color_accuracy', 'signal_preservation', 'natural_appearance', 'noise_control',
      'resolution', 'dynamic_range', 'background_quality', 'star_quality'];
  } else if (classification === 'reflection_nebula') {
    priorities = ['color_accuracy', 'natural_appearance', 'noise_control', 'signal_preservation',
      'background_quality', 'resolution', 'dynamic_range', 'star_quality'];
  } else {
    priorities = ['signal_preservation', 'noise_control', 'color_accuracy', 'dynamic_range',
      'resolution', 'background_quality', 'natural_appearance', 'star_quality'];
  }

  // Determine field characteristics from taxonomy
  const taxEntry = taxonomy[classification];
  const taxTraits = taxEntry.traits || {};
  const hasHa = workflow.includes('Ha');

  // Override signalType based on actual data
  let signalType = taxTraits.signalType || 'broadband';
  if (hasHa && signalType === 'broadband') signalType = 'ha_accented';

  const fieldCharacteristics = {
    // New processing-relevant traits
    signalType,
    structuralZones: taxTraits.structuralZones || 'uniform',
    colorZonation: taxTraits.colorZonation || 'monochromatic',
    starRelationship: taxTraits.starRelationship || 'stars_are_context',
    faintStructureGoal: taxTraits.faintStructureGoal || 'none',
    subjectScale: taxTraits.subjectScale || 'medium',
    dynamicRange: taxTraits.dynamicRange || 'moderate',
    // Legacy boolean traits (kept for backward compat with prompt conditionals)
    haSignalStrength: hasHa ? 'moderate' : 'none',
    dustLanes: taxTraits.hasDustLanes ?? isGalaxy,
    brightCore: taxTraits.hasBrightCore ?? false,
    hasIFN: taxTraits.hasIFN ?? false,
    hasHIIRegions: taxTraits.hasHIIRegions ?? hasHa,
    // Processing guidance
    processingNotes: taxEntry.processingNotes || ''
  };

  return {
    briefId: `brief_${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    target: {
      name: targetName,
      classification,
      classificationSource,
      fieldCharacteristics
    },
    dataDescription: {
      workflow,
      channels: {
        L: !!(config.files?.L?.trim()),
        R: !!(config.files?.R?.trim()),
        G: !!(config.files?.G?.trim()),
        B: !!(config.files?.B?.trim()),
        Ha: !!(config.files?.Ha?.trim())
      }
    },
    aestheticIntent: {
      style,
      colorSaturation: isGalaxy ? 'moderate' : 'vivid',
      contrastLevel: 'moderate',
      backgroundTarget,
      starProminence: isGalaxy ? 'subdued' : 'balanced',
      detailEmphasis: isGalaxy ? 'fine_detail' : 'balanced',
      referenceNotes: opts.intent || ''
    },
    aestheticPreferences: {
      noiseLevel: opts.noiseLevel || 'clean',              // very_clean | clean | natural
      glow: opts.glow || 'moderate',                     // none | subtle | moderate | strong
      starPresence: opts.starPresence || 'prominent',    // minimal | subdued | prominent | rich
    },
    technicalPriorities: priorities,
    hardConstraints: {
      maxPixelValue: 0.995,
      minBackgroundMedian: 0.001,
      maxBackgroundMedian: isGalaxy ? 0.15 : 0.25,
      maxChannelImbalance: 0.05,
      maxMemoryMB: 8000,
      maxWallClockMinutes: opts.maxWallClockMinutes || 60,
      maxIterationsPerAgent: opts.maxIterationsPerAgent || 8
    },
    softGoals: opts.softGoals || [],
    processingProfile: loadProcessingProfiles()[classification] || loadProcessingProfiles()['mixed_field'] || {}
  };
}
