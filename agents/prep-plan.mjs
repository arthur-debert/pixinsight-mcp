// ============================================================================
// Turning a target's processing profile into decisions the prep phase can act on
// ============================================================================
//
// The project already knows that star extraction destroys a star cluster.
// processing-profiles.json says so for both cluster categories:
//
//     "SXT": { "use": false, "reason": "Stars ARE the subject — never remove them" }
//
// and target-taxonomy.json says it twice more, in processingNotes and in the
// starRelationship trait. Deterministic prep read none of it: it ran one fixed
// sequence for all twelve categories and extracted stars from every one.
//
// On NGC 2808 that left the agent a starless layer holding nothing but halo
// glow and extraction residue, and it spent most of its search fighting that
// rather than processing the cluster.
//
// This module is the single place that reads those directives, so prep, the
// prompt and the agent's opening message all describe the same plan.

/**
 * How a profile's per-tool directive maps onto a deterministic phase.
 *
 * The profiles use three values. `false` means the tool is wrong for this kind
 * of object. `true` means it belongs. `"try"` means the choice depends on the
 * data — which prep cannot judge, so it runs the tool and leaves the agent to
 * undo it, the behaviour every category had before this existed.
 */
function decide(directive, { defaultRun = true } = {}) {
  if (directive === undefined || directive === null) {
    return { run: defaultRun, reason: 'no directive in the processing profile' };
  }
  const use = typeof directive === 'object' ? directive.use : directive;
  const stated = typeof directive === 'object' ? (directive.reason || directive.caution) : null;

  if (use === false) return { run: false, reason: stated || 'the profile excludes this tool' };
  if (use === 'try') return { run: true, reason: stated || 'the profile leaves this to the data; prep runs it and the agent may undo it' };
  return { run: true, reason: stated || 'the profile calls for this tool' };
}

/**
 * Build the prep plan for a brief.
 *
 * @param {object} brief - from generateBrief(); carries processingProfile and traits
 * @returns {{extractStars: {run: boolean, reason: string}, starsAreSubject: boolean, classification: string}}
 */
export function buildPrepPlan(brief) {
  const tools = brief?.processingProfile?.tools ?? {};
  const traits = brief?.target?.fieldCharacteristics ?? {};
  const classification = brief?.target?.classification ?? 'mixed_field';

  const starsAreSubject = traits.starRelationship === 'stars_are_subject';
  const extractStars = decide(tools.SXT);

  // The trait and the profile are two statements of the same fact, maintained
  // separately. When they disagree, keeping the stars is the recoverable
  // choice: an agent can remove stars later, but it cannot put back a cluster
  // that prep already deleted.
  if (starsAreSubject && extractStars.run) {
    return {
      classification,
      starsAreSubject,
      extractStars: {
        run: false,
        reason: `the ${classification} trait starRelationship=stars_are_subject overrides the profile, ` +
                `which says SXT ${JSON.stringify(tools.SXT)}`,
      },
    };
  }

  return { classification, starsAreSubject, extractStars };
}

/** A one-line summary of what the plan changed, for prep's log and the cache key. */
export function describePrepPlan(plan) {
  return plan.extractStars.run
    ? `star extraction: yes (${plan.extractStars.reason})`
    : `star extraction: NO — ${plan.extractStars.reason}`;
}
