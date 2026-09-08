# PixInsight MCP — Project Instructions

## What This Project Is
Automated deep sky astrophotography processing pipeline for PixInsight. A Node.js script
drives PixInsight's PJSR scripting engine via file-based IPC to process astronomical images
through a configurable, branching pipeline (HaRGB, HaLRGB, LRGB workflows).

## Environment
- Node.js >= 22
- PixInsight 1.9.4+ at `/Applications/PixInsight/` — the V8 PJSR runtime
- Bridge: `~/.pixinsight-mcp/bridge/` (file-based IPC)
- PJSR files need `#engine v8` and cannot include the pjsr .jsh headers.
  Read `docs/pixinsight-1.9.4-v8-port.md` before touching anything under `pjsr/`.

## Key Commands
```bash
# Check everything is ready, and start PixInsight with the watcher
npm run doctor
npm run launch

# Lint PJSR before running it — the failures it catches are silent
npm run lint:pjsr

# Run pipeline
node scripts/run-pipeline.mjs --config /path/to/config.json

# Resume from checkpoint
node scripts/run-pipeline.mjs --config /path/to/config.json --restart-from stretch

# Start editor
node editor/server.mjs
```

## Project Structure
```
agents/mcp/server.mjs      — The MCP server (standalone and pipeline modes)
scripts/run-pipeline.mjs  — Legacy pipeline script (~1600 lines)
editor/default-config.json — Default pipeline configuration
editor/index.html          — Web UI for pipeline editor
editor/server.mjs          — Editor backend (Express.js)
```

## Skills
The `.claude/skills/pixinsight-pipeline/` directory contains comprehensive processing knowledge:
- **SKILL.md** — Pipeline overview, quick start, parameter tuning guide
- **reference/pjsr-processes.md** — LHE, HDRMT, MorphologicalTransformation, LRGBCombination
- **reference/pjsr-gotchas.md** — ECMAScript 5 constraints, file I/O, crop masks, memory
- **reference/xterminator-tools.md** — SXT, NXT, BXT parameters and best practices
- **reference/ghs-stretch.md** — GHS formula implementation via PixelMath
- **reference/processing-knowledge.md** — Equipment settings, lessons learned, quality assessment

When processing a new target, read the SKILL.md first, then reference files as needed.

## Continuous Skill Improvement
Skills and memory must be kept up to date as the project evolves. After every session:
- **New technique discovered?** Add it to the relevant reference file or SKILL.md
- **Parameter tuned or validated?** Update the parameter tuning guide and processing-knowledge.md
- **Bug or gotcha found?** Document it in pjsr-gotchas.md or the "Common Issues" section
- **Pipeline code changed?** Keep SKILL.md processing order and config format in sync
- **New process or tool used?** Add PJSR parameter reference to pjsr-processes.md

Do this proactively — don't wait to be asked. The goal is that skills always reflect the latest validated knowledge, so any new session starts with the best available information.

## Critical Rules
- PixelMath has NO `pow()` — use `exp(exponent*ln(base))`
- SXT on linear: `stars=true` only (NO unscreen). On non-linear: `stars=true, unscreen=true`
- XISF files open with crop_mask windows — close them immediately
- No spaces in StarAlignment output paths
- Close images aggressively to manage PixInsight memory
- Do NOT use star erosion/threshold — creates artifacts. Non-linear extraction is clean.
- GHS .dylib is not installed — use PixelMath fallback
- `SomeProcess.prototype.CONST` is `undefined` under V8; use `SomeProcess.CONST`
- Unknown process parameters are accepted silently — check `Object.keys(new P)`
- A slash-star pair inside a `//` comment stops a PJSR file loading, silently

## Guard property access — JavaScript will not

Every PJSR snippet runs with two helpers the watcher defines:

```js
var P = configure(new PixelMath, "PixelMath", { expression: "0.5", createNewImage: false });
P.executeOn(view);                       // the object is raw; methods work normally

var s = prop(w, "ImageWindow", "mainView");   // throws if the property is gone
```

`configure` refuses a parameter the process does not have, and refuses a value
that arrived as `undefined` — which is what a legacy `X.prototype.CONST` reads
as. `prop` refuses a property this version removed. Both fail loudly where plain
JavaScript is silent.

Do NOT wrap a process in a Proxy. Calling a native method through one hands the
receiver a proxy and crashes PixInsight; returning a bound copy violates a Proxy
invariant on read-only methods. Both were measured.

## Astrometry is metadata — never throw it away

An astrometric solution is metadata about the pixel grid. A step that does not
change the grid cannot invalidate it. Measured on 1.9.4: GradientCorrection,
NoiseXTerminator and BlurXTerminator all leave the solution untouched, matrix
identical, on a 2930x2561 master.

Only genuinely geometric operations invalidate a solution: StarAlignment, Crop,
Resample, Rotation, IntegerResample, DynamicCrop. After one of those, re-solve.
After anything else, the solution still holds.

If a process ever does drop one, the answer is to COPY IT BACK — it is a few
keywords and a property. Re-solving is minutes of work to recompute something
you already had, and on a dense field it may not converge at all.

Solve the per-channel masters, not the combined colour image: it is cheap
(8-51s each here), it gives four chances instead of one, comparing the solutions
verifies the channels are registered, and ChannelCombination inherits the
solution through `inheritAstrometricSolution`. Never rely on equal dimensions as
proof of registration — two masters can match in size and sit on different grids.
