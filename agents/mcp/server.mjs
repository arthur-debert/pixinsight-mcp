#!/usr/bin/env node
// ============================================================================
// The PixInsight MCP server
// ============================================================================
//
// One server, two modes, one bridge.
//
//   standalone   node agents/mcp/server.mjs [--target "M81"] [--tools SET]
//                For a person driving PixInsight from a chat. No run to govern,
//                so no state machine, no turn budget, no phase policy. Previews
//                and variants go to a session directory under ~/.pixinsight-mcp
//                so the model can still show its work.
//
//   pipeline     node agents/mcp/server.mjs --agent NAME --store DIR --brief FILE
//                Spawned by engine-max.mjs for one agent of a GIGA run. Adds the
//                state machine, repair policies, turn budget and trace file.
//
// The server starts PixInsight itself when nothing is listening, rather than
// serving a tool list where every call times out. See preflight.mjs.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';

import { createBridgeContext } from '../ops/bridge.mjs';
import { ArtifactStore } from '../artifact-store.mjs';
import { buildToolSet } from '../llm/tools.mjs';
import { generateBrief } from '../classifier.mjs';
import { createGovernance, NO_GOVERNANCE } from './pipeline-governance.mjs';
import { blockingInstallationProblems, ensureWatcher, statusReport } from './preflight.mjs';

const log = msg => process.stderr.write(`[mcp] ${msg}\n`);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    agent: null, store: null, brief: null,
    target: null, tools: null, autoLaunch: true, maxTurns: 250,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') opts.agent = argv[++i];
    else if (a === '--store') opts.store = argv[++i] || null;
    else if (a === '--brief') opts.brief = argv[++i] || null;
    else if (a === '--target') opts.target = argv[++i];
    else if (a === '--tools') opts.tools = argv[++i];
    else if (a === '--max-turns') opts.maxTurns = parseInt(argv[++i], 10);
    else if (a === '--no-auto-launch') opts.autoLaunch = false;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const pipelineMode = !!opts.agent;

// ---------------------------------------------------------------------------
// Session context
// ---------------------------------------------------------------------------

// A pipeline agent gets the tools its phase needs; a standalone session gets
// everything except `control`, whose tools (finish, save_variant bookkeeping)
// only mean something inside a run that can end.
const toolSetName = opts.tools ?? (pipelineMode ? opts.agent : '__all__');
const { definitions, handlers } = buildToolSet(toolSetName);
if (!pipelineMode) {
  for (const name of ['finish']) {
    handlers.delete(name);
  }
}
const servedDefinitions = definitions.filter(d => handlers.has(d.name));

const ctx = createBridgeContext({ log });

let store = null;
if (opts.store && fs.existsSync(opts.store)) {
  const manifestPath = path.join(opts.store, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    store = new ArtifactStore(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).runId);
  }
} else if (!pipelineMode) {
  // Previews and variants need somewhere to live even outside a run, or the
  // model loses its only way to look at what it just did.
  store = new ArtifactStore(`session_${new Date().toISOString().slice(0, 10)}_${process.pid}`);
  log(`Session artifacts: ${store.baseDir}`);
}

let brief = null;
if (opts.brief && fs.existsSync(opts.brief)) {
  brief = JSON.parse(fs.readFileSync(opts.brief, 'utf-8'));
} else if (!pipelineMode) {
  // Quality-gate thresholds are keyed off the target's classification, so a
  // standalone session still needs a brief. Naming the target sharpens it;
  // without one the neutral mixed_field profile applies.
  brief = generateBrief({ files: { targetName: opts.target || 'Unknown', R: 'r', G: 'g', B: 'b' } });
  if (opts.target) log(`Target ${opts.target} classified as ${brief.target.classification}.`);
}

const governance = pipelineMode
  ? createGovernance({ agentName: opts.agent, store, brief, maxTurns: opts.maxTurns })
  : NO_GOVERNANCE;

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

const TRACE_START = Date.now();
const traceFile = opts.store ? path.join(opts.store, 'trace.jsonl') : null;
let traceSeq = 0;

function writeTrace(entry) {
  if (!traceFile) return;
  try { fs.appendFileSync(traceFile, JSON.stringify(entry) + '\n'); } catch {}
}

function summarizeArgs(args) {
  if (!args) return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = (typeof v === 'string' && v.length > 200) ? v.slice(0, 100) + '...[truncated]' : v;
  }
  return out;
}

function textOf(result) {
  if (Array.isArray(result)) return result.filter(r => r.type === 'text').map(r => r.text).join(' ');
  if (result?.type === 'text') return result.text;
  return String(result);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const STATUS_TOOL = {
  name: 'pixinsight_status',
  description:
    'Report whether PixInsight and the PJSR watcher are ready, what the watcher is doing, and how to recover if not. ' +
    'Call this first when a tool times out or fails in a way that suggests the application rather than the image.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

const server = new Server(
  { name: 'pixinsight', version: '4.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    STATUS_TOOL,
    ...servedDefinitions.map(d => ({
      name: d.name,
      description: d.description,
      inputSchema: d.input_schema,
    })),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'pixinsight_status') {
    const report = await statusReport();
    return { content: [{ type: 'text', text: report.text }] };
  }

  const handler = handlers.get(name);
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }

  const seq = traceSeq++;
  const callStart = Date.now();
  const traceEntry = {
    seq,
    ts: callStart,
    relMs: callStart - TRACE_START,
    tool: name,
    args: summarizeArgs(args),
    viewId: args?.view_id || args?.source_id || args?.target_id || args?.rgb_id || args?.l_id || null,
  };

  const gate = governance.beforeCall(name, args || {});
  if (!gate.allowed) {
    traceEntry.durationMs = 0;
    traceEntry.error = gate.reason;
    traceEntry.resultSummary = null;
    writeTrace(traceEntry);
    return { content: [{ type: 'text', text: gate.message }] };
  }

  try {
    // Every tool call goes through the bridge, so this is the one place that
    // has to hold for any of them to work.
    await ensureWatcher({ autoLaunch: opts.autoLaunch, log });

    const result = await handler(ctx, store, brief, args || {}, opts.agent ?? 'standalone');
    const resultText = textOf(result);

    traceEntry.durationMs = Date.now() - callStart;
    traceEntry.resultSummary = resultText.slice(0, 500);
    traceEntry.error = null;
    writeTrace(traceEntry);

    const suffix = governance.afterCall(name, args || {}, resultText);

    if (Array.isArray(result)) {
      const items = result.map(r => r.type === 'image'
        ? { type: 'text', text: '[Image saved to disk — use the Read tool to view the preview file]' }
        : { type: 'text', text: r.text || String(r) });
      if (items.length > 0) items[items.length - 1].text += suffix;
      return { content: items };
    }
    return { content: [{ type: 'text', text: textOf(result) + suffix }] };
  } catch (err) {
    traceEntry.durationMs = Date.now() - callStart;
    traceEntry.resultSummary = null;
    traceEntry.error = err.message;
    writeTrace(traceEntry);
    log(`Tool error (${name}): ${err.message}`);

    // A bridge-level failure is about the application, not the image, and the
    // model should be told to look there rather than retry the same call.
    const backendHint = (err.name === 'BridgeCrashError' || err.name === 'WatcherUnavailableError')
      ? '\nThis is a PixInsight problem rather than an image one. Call pixinsight_status for the current state.'
      : '';
    return { content: [{ type: 'text', text: `Error: ${err.message}${backendHint}` + governance.afterError(name, args || {}) }] };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Refuse to serve tools that cannot possibly work. A missing application or
// missing XTerminator module is a setup problem, and failing here names it once
// instead of surfacing as a different confusing error per tool.
const blockers = blockingInstallationProblems();
if (blockers.length > 0) {
  for (const b of blockers) log(`FATAL ${b.name}: ${b.detail}`);
  log('Refusing to start. Run: node scripts/pi-doctor.mjs');
  process.exit(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);
log(`Ready — ${servedDefinitions.length} tools, ${pipelineMode ? `pipeline mode (${opts.agent})` : 'standalone mode'}.`);

// Auto-exit when the parent disconnects.
process.stdin.on('end', () => {
  log('stdin closed — parent exited. Shutting down.');
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
