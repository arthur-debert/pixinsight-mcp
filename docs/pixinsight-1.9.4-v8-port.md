# Porting the bridge to PixInsight 1.9.4 (V8 runtime)

PixInsight 1.9.4 "Lockhart" replaced the SpiderMonkey 24 JavaScript engine that
had powered PJSR since 2015 with Google's V8, and on Apple Silicon it ships no
legacy engine at all. Every script written for the old runtime stops working
there. This document records what broke, how each failure presents itself, and
what the fix was, because almost none of these failures produce an error message
a caller can see.

Upstream's porting guide is at
<https://pixinsight.net/dev/index.php?articles/the-new-v8-javascript-runtime-in-pixinsight-1-9-4-script-porting-guide.13/>.

## Selecting the runtime

A PJSR file must declare `#engine v8` before anything else. Without the
directive the core selects the legacy engine and reports:

```
*** Error: The legacy 'sm' JavaScript engine is not available in this PixInsight build.
```

That message goes to the Process Console. In `--automation-mode` there is no
Process Console window, so the script simply never runs and PixInsight sits idle
at 0% CPU looking perfectly healthy.

## The failures, in the order they cost time

### 1. A slash-star pair inside a line comment kills the file silently

The preprocessor strips comments by scanning for delimiters without tracking
which kind of comment it is already inside. Writing a glob like `pjsr/*.jsh`
inside a `//` comment opens a block comment that runs to the end of the file.

There is no error, no console output, and no partial execution. The file loads to
nothing. This one is worth knowing about before it happens to you: the symptom is
identical to a missing engine directive, to a syntax error, and to a crashed
watcher.

`scripts/pjsr-lint.mjs` flags it.

### 2. The pjsr .jsh headers are gone

`#include <pjsr/Sizer.jsh>` and its siblings no longer compile. The headers
defined constructor-stealing base classes (`this.__base__ = Sizer`) and
underscore-style constants (`FrameStyle_Box`), both of which V8 rejects.
Enumerations are class properties now: `FrameStyle.Box`, `UndoFlag.NoSwapFile`.

The watcher included seven of those headers plus the AdP `ImageSolver.js` library
in order to expose plate solving. All of it is removed. See *Plate solving*
below for what that costs.

### 3. Legacy enumeration access returns undefined instead of throwing

```js
SCNR.prototype.Green        // undefined under V8
SCNR.Green                  // 1
```

Reading the constant does not fail. Assigning the resulting `undefined` to a
process parameter throws — with the message `undefined` and nothing else, from
inside `executeOn`, with no indication of which parameter was involved.

104 call sites across `agents/` and `scripts/` used the `.prototype.` form.

### 4. Some enumerations were also renamed

`AutomaticBackgroundExtractor` scoped its enumerations to the parameter they
belong to:

| Legacy | V8 |
|---|---|
| `AutomaticBackgroundExtractor.Subtract` | `AutomaticBackgroundExtractor.Correction_Subtract` |
| `AutomaticBackgroundExtractor.SameAsTarget` | `AutomaticBackgroundExtractor.CorrectedFormat_SameAsTarget` |
| `AutomaticBackgroundExtractor.f32` | `AutomaticBackgroundExtractor.ModelFormat_f32` (or `CorrectedFormat_f32`, depending on the parameter) |

Renames like this are invisible to a mechanical `.prototype.` sweep, and they
fail the same way as case 3. To find them, enumerate the class from inside
PixInsight:

```js
Object.getOwnPropertyNames(AutomaticBackgroundExtractor)
```

### 5. Unknown process parameters are accepted in silence

```js
var P = new HDRMultiscaleTransform;
P.scalingFunctionNoiseLayers = 1;   // no such parameter in 1.9.4 — accepted anyway
```

The assignment creates an ordinary JavaScript property and the process ignores
it. Parameters that were removed between versions therefore produce no error and
no effect, only different output. `Object.keys(new SomeProcess)` lists what a
process actually accepts.

### 6. Deprecated globals

These still work and still do the right thing, but each prints a warning once per
runtime — which means once, at startup, into a console nobody is reading.

| Deprecated | Current |
|---|---|
| `processEvents()` | `CoreApplication.processEvents()` |
| `msleep()` | `System.msleep()` |
| `sleep()` | `System.sleep()` |
| `searchDirectory()` | `File.searchDirectory()` |
| `cpuId()`, `cpuInfo()` | `System.cpuId()`, `System.cpuInfo()` |
| `getEnvironmentVariable()` | `System.getEnvironmentVariable()` |
| `replaceEnvironmentVariables()` | `System.replaceEnvironmentVariables()` |
| `physicalMemoryStatus()` | `System.physicalMemoryStatus()` |
| `systemOffsetFromUTC()` | `System.offsetFromUTC()` |
| `loadResource()`, `unloadResource()` | `CoreApplication.loadResource()`, `.unloadResource()` |

`gc()` was removed outright with no replacement: V8 collects on its own, and core
memory is released through `ImageWindow.purge()`.

The watcher exercises `CoreApplication.processEvents()`, `System.msleep()` and
`File.searchDirectory()` during startup and writes the resulting console output
to `~/.pixinsight-mcp/bridge/logs/watcher-startup.log`, so a warning for anything
the command loop depends on appears there rather than surfacing mid-run.

### 7. Automation mode does not stop every modal dialog

PixInsight's own help is precise about this: automation mode works by "not
showing **many** informative and warning messages". Many, not all.

Six geometry processes carry their own `noGUIMessages` parameter, and it
defaults to false:

    Resample, Rotation, Crop, IntegerResample, FastRotation, DynamicCrop

(`ImageIntegration` and `Debayer` have it too, already defaulting to true.)

A modal dialog is the worst failure this bridge has. It blocks the event loop
the watcher polls in, so the watcher stops answering, every later call times out,
and **nothing on the Node side can dismiss it** — the automation waits for a
human to click a button that may be on a machine nobody is watching. It looks
exactly like a hang.

Two defences. Every construction of those processes sets `noGUIMessages = true`,
and `scripts/pjsr-audit-params.mjs` fails when one does not — it asks the running
PixInsight which classes carry the parameter, so the rule cannot go stale against
a future version. And when a watcher does go quiet while reporting itself idle,
the bridge names a modal dialog as the likely cause rather than saying only that
the loop stopped.

### 8. Null replaced the "invalid" placeholder objects

Accessors like `View.window` and `ImageWindow.mask` return `null` for invalid
references instead of a placeholder object. Truthiness tests that used to be safe
now crash. `ImageWindow.windowById()` still returns a checkable object, so
`if (!w.isNull)` continues to work.

## Plate solving is currently unavailable

`ImageSolver` was never a core process. It came from the AdP script library that
the watcher used to `#include`, and that library has not been ported to V8 — the
copy shipped in `/Applications/PixInsight/src/scripts/AdP/` carries no engine
directive, so it cannot load on 1.9.4 either.

Affected: the `run_plate_solve` tool, and the fallback in
`agents/llm/deterministic-prep.mjs` for masters that arrive without a WCS
solution. Masters that already carry an astrometric solution are unaffected,
which covers the normal WBPP output, and SPCC works on those as before.

## Tools

```bash
node scripts/pjsr-lint.mjs      # the silent failures above, caught statically
node scripts/pi-doctor.mjs      # install, modules, bridge, watcher, round trip
node scripts/pi-launch.mjs      # start PixInsight and wait for the watcher to answer
```
