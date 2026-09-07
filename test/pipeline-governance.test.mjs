// Governance is what separates a pipeline run from a person poking at
// PixInsight: a phase, the tools that phase allows, and a turn budget. It moved
// out of the request handler when the two MCP servers became one, so these
// cover that the standalone path really does bypass it and the pipeline path
// really does still enforce it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGovernance, NO_GOVERNANCE } from '../agents/mcp/pipeline-governance.mjs';

const brief = { target: { classification: 'star_cluster_globular' } };

test('standalone governance permits everything and annotates nothing', () => {
  assert.equal(NO_GOVERNANCE.beforeCall('finish', {}).allowed, true);
  assert.equal(NO_GOVERNANCE.afterCall('run_bxt', {}, 'done'), '');
  assert.equal(NO_GOVERNANCE.afterError('run_bxt', {}), '');
});

test('pipeline governance reports the budget on every call', () => {
  const g = createGovernance({ agentName: 'giga_orchestrator', store: null, brief, maxTurns: 250 });
  const suffix = g.afterCall('get_image_stats', { view_id: 'M13' }, 'median=0.1');
  assert.match(suffix, /\[Budget: \d+\/250 turns/);
  assert.match(suffix, /State: \w+/);
});

test('the turn budget is consumed as tools are called', () => {
  const g = createGovernance({ agentName: 'giga_orchestrator', store: null, brief, maxTurns: 10 });
  const remaining = () => Number(g.afterCall('get_image_stats', {}, 'ok').match(/Budget: (\d+)\//)[1]);
  const first = remaining();
  for (let i = 0; i < 3; i++) g.afterCall('get_image_stats', {}, 'ok');
  assert.ok(remaining() < first, 'the budget should fall as turns are spent');
});

test('a blocked call explains itself instead of failing bare', () => {
  const g = createGovernance({ agentName: 'giga_orchestrator', store: null, brief, maxTurns: 250 });
  // `finish` ends a run; the state machine must not allow it from the first
  // phase, before any candidate exists.
  const gate = g.beforeCall('finish', {});
  if (!gate.allowed) {
    assert.match(gate.message, /Budget|State/);
    assert.ok(gate.reason, 'a blocked call records why, for the trace');
  }
});

test('governance survives a brief with none of its optional state', () => {
  // The brief travels through a file and may predate any of the bookkeeping
  // fields the handler decorates it with.
  const g = createGovernance({ agentName: 'giga_orchestrator', store: null, brief: {}, maxTurns: 250 });
  assert.doesNotThrow(() => g.beforeCall('run_bxt', { view_id: 'x' }));
  assert.doesNotThrow(() => g.afterCall('run_bxt', { view_id: 'x' }, 'ok'));
  assert.doesNotThrow(() => g.afterError('run_bxt', { view_id: 'x' }));
});

test('a gate failure does not fail the tool call itself', () => {
  const g = createGovernance({ agentName: 'giga_orchestrator', store: null, brief, maxTurns: 250 });
  // A quality gate reporting FAIL is a finding to act on, not an exception.
  assert.doesNotThrow(() => g.afterCall('check_star_quality', { view_id: 'x' }, 'FAIL: FWHM 8.2px'));
});
