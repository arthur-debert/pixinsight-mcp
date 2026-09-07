// ============================================================================
// Pipeline governance: state machine, repair policies, budget, provenance
// ============================================================================
//
// This is what a pipeline run adds on top of the plain tools: a phase the agent
// is in, the tools that phase allows, a turn budget, structured repair when a
// quality gate fails, and a completeness check before composing.
//
// None of it applies to a person driving PixInsight through the MCP server from
// a chat, which is why it lives behind an interface the server can leave out
// entirely. See NO_GOVERNANCE below.

import { createStateMachine, checkBranchCompleteness } from '../llm/state-machine.mjs';
import { findRepairPolicy, checkRepairToolAccess, generateRepairGuidance } from '../llm/repair-policies.mjs';

const COMPOSITION_TOOLS = [
  'lrgb_combine', 'ha_inject_red', 'ha_inject_luminance',
  'dynamic_narrowband_blend', 'star_screen_blend', 'star_protected_blend',
];
const STAR_MODIFYING_TOOLS = new Set([
  'run_pixelmath', 'run_curves', 'stretch_stars', 'run_nxt', 'run_bxt',
]);
const GATE_TOOLS = [
  'check_saturation', 'scan_burnt_regions', 'check_star_quality',
  'check_tonal_presence', 'check_highlight_texture',
];
const COMPOSE_ENTRY_TOOLS = new Set(['lrgb_combine', 'star_screen_blend', 'star_protected_blend']);

/** Governance that permits everything and annotates nothing. */
export const NO_GOVERNANCE = {
  beforeCall: () => ({ allowed: true }),
  afterCall: () => '',
  afterError: () => '',
};

export function createGovernance({ agentName, store, brief, maxTurns = 250 }) {
  const stateMachine = createStateMachine(maxTurns);
  // Which tool last composed each view, so a gate failure can be traced to the
  // operation that caused it rather than to whatever ran most recently.
  const viewProvenance = new Map();
  let seq = 0;

  function viewIdOf(args) {
    return args?.view_id || args?.rgb_id || args?.target_id || null;
  }

  function syncBrief() {
    if (!brief) return;
    brief._budget = stateMachine.getBudgetStatus();
    brief._provenance = viewProvenance;
    brief._stateMachine = stateMachine;
  }

  function budgetSuffix(extra = '') {
    const budget = stateMachine.getBudgetStatus();
    return `\n[Budget: ${budget.turnsRemaining}/${budget.maxTurns} turns — ${budget.status} | State: ${stateMachine.state}` +
      (budget.guidance.length > 0 ? ` | ${budget.guidance.join('; ')}` : '') + ']' + extra;
  }

  return {
    beforeCall(name, args) {
      syncBrief();

      const access = stateMachine.checkToolAccess(name);
      if (!access.allowed) {
        if (stateMachine.state === 'repair' && stateMachine.repairPolicy) {
          const repairAccess = checkRepairToolAccess(name, args || {}, stateMachine.repairPolicy);
          if (!repairAccess.allowed) {
            return {
              allowed: false,
              reason: `REPAIR POLICY VIOLATION: ${repairAccess.reason}`,
              message: `REPAIR POLICY VIOLATION: ${repairAccess.reason}` + budgetSuffix(),
            };
          }
          // The repair policy grants access the general whitelist withholds.
        } else {
          return {
            allowed: false,
            reason: `BLOCKED (state ${stateMachine.state}): ${access.reason}`,
            message: `STATE POLICY: ${access.reason}` + budgetSuffix(),
          };
        }
      }

      const viewId = viewIdOf(args);
      if (COMPOSITION_TOOLS.includes(name) && viewId) {
        viewProvenance.set(viewId, { tool: name, params: args, seq });
      }

      // A star-modifying tool invalidates whatever the last integrity check
      // concluded about that view.
      if (STAR_MODIFYING_TOOLS.has(name) && viewId && brief?._starIntegrity?.[viewId]) {
        delete brief._starIntegrity[viewId];
      }
      if (brief?._starIntegrity) {
        for (const key of Object.keys(brief._starIntegrity)) {
          brief._starIntegrity[key].turnsAgo = (brief._starIntegrity[key].turnsAgo || 0) + 1;
        }
      }

      seq++;
      return { allowed: true };
    },

    afterCall(name, args, resultText) {
      stateMachine.recordToolCall(name, args || {}, resultText);

      if (name === 'check_star_layer_integrity' && brief) {
        const starViewId = args?.view_id;
        if (starViewId && brief._starIntegrity?.[starViewId]) {
          brief._starIntegrity[starViewId].turnsAgo = 0;
        }
      }

      let repairGuidance = '';
      if (GATE_TOOLS.includes(name)) {
        const failed = resultText.includes('FAIL') || resultText.includes('REJECTED');
        if (failed && stateMachine.state !== 'repair') {
          const prov = viewProvenance.get(viewIdOf(args) || args?.view_id);
          const category = brief?.target?.classification || 'unknown';
          const policy = findRepairPolicy(name, { resultText }, prov, category);
          if (policy && !policy.advisory && stateMachine.state === 'compose') {
            stateMachine.enterRepair(policy);
            repairGuidance = '\n\n' + generateRepairGuidance(policy, prov);
          }
        }
      }

      let branchWarnings = '';
      if (stateMachine.state === 'compose' && COMPOSE_ENTRY_TOOLS.has(name) && store) {
        try {
          const bc = checkBranchCompleteness(store.listVariants(agentName), brief);
          if (!bc.complete && bc.warnings.length > 0) {
            const budget = stateMachine.getBudgetStatus();
            const budgetAllowsBlock = budget.status !== 'converge' && budget.status !== 'critical';
            const overridden = stateMachine._branchCompletenessOverride;
            if (budgetAllowsBlock && !overridden) {
              stateMachine.transitionTo('generate_candidates');
              branchWarnings = '\n[BRANCH COMPLETENESS — BLOCKED] Compose rejected: incomplete branches. ' +
                'You MUST go back and generate more variants before composing.\n' +
                bc.warnings.map(w => '  - ' + w).join('\n') +
                '\nReturn to generate_candidates and address the gaps above, then retry composition.';
            } else {
              const reason = overridden ? 'override active' : `budget ${budget.status}`;
              branchWarnings = `\n[BRANCH COMPLETENESS — advisory, ${reason}] ` + bc.warnings.join(' | ');
            }
          }
        } catch {
          // Completeness is advice, never a reason to fail the tool call.
        }
      }

      return budgetSuffix(repairGuidance + branchWarnings);
    },

    afterError(name, args) {
      stateMachine.recordToolCall(name, args || {}, '');
      return budgetSuffix();
    },
  };
}
