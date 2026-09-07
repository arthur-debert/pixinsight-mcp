#engine v8

// PixInsight MCP Watcher Script
//
// Runs inside PixInsight's PJSR V8 runtime (PixInsight 1.9.4 "Lockhart" and later).
// Polls the bridge directory for command files, executes them, writes result files.
//
// The V8 runtime replaced SpiderMonkey in 1.9.4 and dropped the legacy engine
// entirely on Apple Silicon, so the "engine v8" directive above is mandatory.
// Without it the core refuses to load this file and reports "the legacy 'sm'
// JavaScript engine is not available in this PixInsight build".
//
// Three consequences shape the code below:
//
//   - The pjsr .jsh headers are gone, and so are the include directives that
//     pulled them in. Enumeration constants are class properties now
//     (SCNR.Green, UndoFlag.NoSwapFile), not globals.
//
//   - SomeProcess.prototype.SomeConstant evaluates to undefined instead of
//     throwing, so a leftover ".prototype." silently writes garbage into a
//     process parameter. Always reach for SomeProcess.SomeConstant.
//
//   - The preprocessor strips comments by scanning for delimiters without
//     tracking which comment it is already inside. A slash-star pair typed
//     inside a line comment therefore opens a block comment that swallows the
//     rest of the file, and the load fails with no message at all. Never write
//     a glob like "pjsr" slash star ".jsh" in a comment here.

// ----------------------------------------------------------------------------
// Astrometry
//
// PixInsight 1.9.4 ships a V8 port of ImageSolver under src/scripts/ImageSolver.
// The older AdP copy this watcher used to pull in was never ported and cannot
// load here at all.
//
// Only the engine is included, never ImageSolverDialog.js: the dialog fails to
// load in automation mode, and it takes the whole watcher down with it.
// ----------------------------------------------------------------------------

#define VERSION "6.4.1"
#define TITLE "ImageSolver"
#define SOLVER_SETTINGS_MODULE "ImageSolver"
#define SETTINGS_MODULE "ImageSolver"

#include <pjsr/astrometry/AstrometricMetadata.js>
#include <pjsr/astrometry/AstronomicalCatalogs.js>
#include "/Applications/PixInsight/src/scripts/ImageSolver/ImageSolverEngine.js"

// ============================================================================
// Configuration
// ============================================================================

var BRIDGE_DIR = File.homeDirectory + "/.pixinsight-mcp/bridge";
var COMMANDS_DIR = BRIDGE_DIR + "/commands";
var RESULTS_DIR = BRIDGE_DIR + "/results";
var LOGS_DIR = BRIDGE_DIR + "/logs";
var POLL_INTERVAL_MS = 1000;
var WATCHER_VERSION = "0.2.0";

// Heartbeat file. The Node side reads it to tell three states apart that all
// look identical from the command directory: PixInsight is not running, the
// watcher never loaded (a PJSR compile error, for instance), and the watcher is
// alive but busy inside a long process. Rewritten on every idle cycle.
var HEARTBEAT_PATH = BRIDGE_DIR + "/watcher.json";

// ============================================================================
// File Helpers (PJSR File API)
// ============================================================================

function readTextFile(path) {
   var lines = File.readLines(path);
   return lines.join("\n");
}

function writeTextFile(path, text) {
   File.writeTextFile(path, text);
}

function deleteFile(path) {
   if (File.exists(path)) {
      File.remove(path);
   }
}

function ensureDirectory(path) {
   if (!File.directoryExists(path)) {
      File.createDirectory(path, true);
   }
}

function listJsonFiles(dirPattern) {
   try {
      return File.searchDirectory(dirPattern);
   } catch (e) {
      return [];
   }
}

function getTimestamp() {
   var d = new Date();
   return d.toISOString();
}

// ============================================================================
// Heartbeat
// ============================================================================

function coreVersionString() {
   try {
      return CoreApplication.versionMajor + "." +
             CoreApplication.versionMinor + "." +
             CoreApplication.versionRelease + "." +
             CoreApplication.versionRevision;
   } catch (e) {
      return "unknown";
   }
}

// State the Node side can read while a command is in flight. `state` is "idle"
// or "busy"; when busy, `currentCommand` and `busySince` say what is running and
// since when, which is what lets the client wait out a 20-minute BlurXTerminator
// run instead of declaring a timeout.
// The command loop polls every 60ms, but the client's staleness threshold is
// 30 seconds. Rewriting the heartbeat on every cycle would be 16 file writes a
// second for no benefit, and those writes land in the same directory the loop
// is scanning. A busy or idle TRANSITION always writes; a repeat of the same
// state waits out this interval.
var HEARTBEAT_MIN_INTERVAL_MS = 1000;
var g_lastHeartbeatAt = 0;
var g_lastHeartbeatState = null;

function writeHeartbeat(state, currentCommand, commandCount) {
   var now = Date.now();
   var isTransition = (state !== g_lastHeartbeatState) || (currentCommand !== null);
   if (!isTransition && (now - g_lastHeartbeatAt) < HEARTBEAT_MIN_INTERVAL_MS) {
      return;
   }
   g_lastHeartbeatAt = now;
   g_lastHeartbeatState = state;

   try {
      File.writeTextFile(HEARTBEAT_PATH, JSON.stringify({
         version: WATCHER_VERSION,
         engine: "v8",
         pid: -1,
         coreVersion: coreVersionString(),
         state: state,
         currentCommand: currentCommand || null,
         busySince: currentCommand ? getTimestamp() : null,
         commandsProcessed: commandCount,
         timestamp: getTimestamp()
      }));
   } catch (e) {
      // A heartbeat write failure must never take the watcher down: the command
      // loop is still the thing that matters.
      console.warningln("[MCP Watcher] Heartbeat write failed: " + e.message);
   }
}

// ============================================================================
// Command Handlers
// ============================================================================

function handleListOpenImages(command) {
   var windows = ImageWindow.windows;
   var images = [];
   for (var i = 0; i < windows.length; ++i) {
      var w = windows[i];
      var v = w.mainView;
      var img = v.image;
      images.push({
         id: v.id,
         filePath: w.filePath || null,
         width: img.width,
         height: img.height,
         channels: img.numberOfChannels,
         isColor: img.isColor,
         bitDepth: img.bitsPerSample
      });
   }
   return {
      status: "success",
      outputs: { images: images },
      message: "Found " + images.length + " open image(s)"
   };
}

function handleOpenImage(command) {
   var filePath = command.parameters.filePath;
   if (!File.exists(filePath)) {
      throw new Error("File not found: " + filePath);
   }
   var windows = ImageWindow.open(filePath);
   if (windows.length === 0) {
      throw new Error("Failed to open image: " + filePath);
   }
   var w = windows[0];
   w.show();
   var v = w.mainView;
   var img = v.image;
   return {
      status: "success",
      outputs: {
         id: v.id,
         width: img.width,
         height: img.height,
         channels: img.numberOfChannels
      },
      message: "Opened " + v.id
   };
}

function handleSaveImage(command) {
   var viewId = command.parameters.viewId;
   var filePath = command.parameters.filePath;
   var overwrite = command.parameters.overwrite || false;

   var window = findWindowByViewId(viewId);
   if (!window) {
      throw new Error("Image not found: " + viewId);
   }
   if (File.exists(filePath) && !overwrite) {
      throw new Error("File already exists (set overwrite=true): " + filePath);
   }
   window.saveAs(filePath, false, false, false, false);
   return {
      status: "success",
      outputs: { filePath: filePath },
      message: "Saved " + viewId + " to " + filePath
   };
}

function handleCloseImage(command) {
   var viewId = command.parameters.viewId;
   var window = findWindowByViewId(viewId);
   if (!window) {
      throw new Error("Image not found: " + viewId);
   }
   window.forceClose();
   return {
      status: "success",
      outputs: {},
      message: "Closed " + viewId
   };
}

function handleGetImageStatistics(command) {
   var viewId = command.parameters.viewId;
   var window = findWindowByViewId(viewId);
   if (!window) {
      throw new Error("Image not found: " + viewId);
   }
   var img = window.mainView.image;
   var stats = [];
   var channelNames = img.isColor ? ["Red", "Green", "Blue"] : ["Gray"];

   for (var c = 0; c < img.numberOfChannels; ++c) {
      img.selectedChannel = c;
      stats.push({
         channel: c,
         channelName: c < channelNames.length ? channelNames[c] : "Channel_" + c,
         mean: img.mean(),
         median: img.median(),
         stdDev: img.stdDev(),
         min: img.minimum(),
         max: img.maximum()
      });
   }
   img.resetSelections();

   return {
      status: "success",
      outputs: { statistics: stats },
      message: "Statistics for " + viewId + " (" + stats.length + " channel(s))"
   };
}

// ============================================================================
// Process Execution Handlers
// ============================================================================

function handleRunPixelMath(command) {
   var P = new PixelMath;
   P.expression = command.parameters.expression || "";
   P.expression1 = command.parameters.expression1 || "";
   P.expression2 = command.parameters.expression2 || "";
   P.useSingleExpression = command.parameters.useSingleExpression !== false;
   P.createNewImage = command.parameters.createNewImage || false;
   if (command.parameters.newImageId) {
      P.newImageId = command.parameters.newImageId;
   }

   if (command.targetView) {
      var view = findViewById(command.targetView);
      if (!view) throw new Error("View not found: " + command.targetView);
      P.executeOn(view);
   } else {
      P.executeGlobal();
   }
   return {
      status: "success",
      outputs: {},
      message: "PixelMath executed: " + command.parameters.expression
   };
}

function handleRemoveGradient(command) {
   var P = new AutomaticBackgroundExtractor;
   P.polyDegree = command.parameters.polyDegree || 4;
   P.tolerance = command.parameters.tolerance || 1.0;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Gradient removed from " + command.targetView + " (ABE, degree " + P.polyDegree + ")"
   };
}

function handleColorCalibrate(command) {
   var method = command.parameters.method || "spcc";
   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);

   if (method === "spcc") {
      var P = new SpectrophotometricColorCalibration;
      P.executeOn(view);
   } else if (method === "pcc") {
      var P = new PhotometricColorCalibration;
      P.executeOn(view);
   } else {
      var P = new ColorCalibration;
      P.executeOn(view);
   }
   return {
      status: "success",
      outputs: {},
      message: "Color calibrated " + command.targetView + " using " + method.toUpperCase()
   };
}

function handleRemoveGreenCast(command) {
   var P = new SCNR;
   P.colorToRemove = SCNR.Green;
   P.amount = command.parameters.amount !== undefined ? command.parameters.amount : 1.0;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Green cast removed from " + command.targetView
   };
}

function handleStretchImage(command) {
   var method = command.parameters.method || "auto";
   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);

   if (method === "auto") {
      var P = new AutoHistogram;
      P.executeOn(view);
   } else if (method === "stf") {
      // Apply STF auto-stretch then apply permanently via HistogramTransformation
      var stf = new ScreenTransferFunction;
      stf.executeOn(view);
      // Read STF values and apply as permanent HT
      // For now, just apply STF (non-destructive preview)
      return {
         status: "success",
         outputs: {},
         message: "STF auto-stretch applied to " + command.targetView + " (preview only, non-destructive)"
      };
   } else {
      // Manual HistogramTransformation
      var P = new HistogramTransformation;
      var sc = command.parameters.shadowsClipping || 0.0;
      var mt = command.parameters.midtones || 0.5;
      P.H = [
         [0, 0.5, 0.5, 0.5, 1.0],
         [0, 0.5, 0.5, 0.5, 1.0],
         [0, 0.5, 0.5, 0.5, 1.0],
         [sc, 0.5, mt, 0.5, 1.0],
         [0, 0.5, 0.5, 0.5, 1.0]
      ];
      P.executeOn(view);
   }
   return {
      status: "success",
      outputs: {},
      message: "Stretched " + command.targetView + " using " + method + " method"
   };
}

function handleApplyCurves(command) {
   var P = new CurvesTransformation;
   var curvePoints = command.parameters.curvePoints || [[0, 0], [1, 1]];
   var channel = command.parameters.channel || "rgb";

   // CurvesTransformation uses arrays like: [ [x0,y0], [x1,y1], ... ]
   // Channel mapping: R=0, G=1, B=2, RGB/K=3, alpha=4, L=5, a=6, b=7, c=8, H=9, S=10
   var channelMap = {
      "red": "R", "green": "G", "blue": "B", "rgb": "K",
      "lightness": "L", "saturation": "S"
   };

   // Set the curve for the selected channel
   var ch = channelMap[channel] || "K";
   P[ch] = curvePoints;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Curves applied to " + command.targetView + " (" + channel + " channel)"
   };
}

function handleDenoise(command) {
   var P = new MultiscaleLinearTransform;
   var layers = command.parameters.layers || 4;
   // MLT uses an array of layer configurations
   // Default: enable noise reduction on first N layers
   var layerConfig = [];
   for (var i = 0; i < layers; ++i) {
      // [enabled, biasEnabled, bias, noiseReductionEnabled, noiseReductionThreshold, noiseReductionAmount, ...]
      layerConfig.push([true, true, 0.000, true, 3.000, 1.00, false]);
   }
   // Add the residual layer (no noise reduction)
   layerConfig.push([true, true, 0.000, false, 3.000, 1.00, false]);
   P.layers = layerConfig;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Denoised " + command.targetView + " (MLT, " + layers + " layers)"
   };
}

function handleSharpen(command) {
   var P = new UnsharpMask;
   P.sigma = command.parameters.sigma || 2.0;
   P.amount = command.parameters.amount || 0.8;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Sharpened " + command.targetView + " (sigma: " + P.sigma + ", amount: " + P.amount + ")"
   };
}

function handleDeconvolve(command) {
   var P = new Deconvolution;
   // Use a Gaussian PSF
   P.algorithm = Deconvolution.RichardsonLucy;
   P.psfMode = Deconvolution.Gaussian;
   P.psfGaussianSigma = command.parameters.psfSigma || 2.5;
   P.iterations = [
      [command.parameters.iterations || 50, false, 0, 0, 0, false, 0, 0]
   ];

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Deconvolved " + command.targetView
   };
}

function handleCombineLRGB(command) {
   var P = new LRGBCombination;
   // One `channels` array of [enabled, viewId, weight], ordered L, R, G, B.
   // Only L is supplied; the RGB channels come from the target view itself.
   P.channels = [
      [true,  command.parameters.luminanceViewId, command.parameters.luminanceWeight || 1.0],
      [false, "", 1],
      [false, "", 1],
      [false, "", 1]
   ];

   // Execute on the RGB image
   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "LRGB combined onto " + command.targetView
   };
}

function handleBlendNarrowband(command) {
   var P = new PixelMath;
   var nbView = command.parameters.narrowbandViewId;
   var strength = command.parameters.blendStrength || 1.0;
   var mode = command.parameters.blendMode || "max";
   var channel = command.parameters.targetChannel || "red";

   // Build PixelMath expression based on blend mode
   var expr;
   if (mode === "max") {
      expr = "max($T, " + nbView + " * " + strength + ")";
   } else if (mode === "screen") {
      expr = "~(~$T * ~(" + nbView + " * " + strength + "))";
   } else if (mode === "add") {
      expr = "$T + " + nbView + " * " + strength;
   } else {
      // Custom fallback: simple max
      expr = "max($T, " + nbView + " * " + strength + ")";
   }

   if (channel === "red") {
      P.expression = expr;
      P.expression1 = "$T";
      P.expression2 = "$T";
      P.useSingleExpression = false;
   } else if (channel === "all" || channel === "luminance") {
      P.expression = expr;
      P.useSingleExpression = true;
   } else {
      P.expression = expr;
      P.useSingleExpression = true;
   }
   P.createNewImage = false;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Blended " + nbView + " into " + command.targetView + " (" + mode + ", strength: " + strength + ")"
   };
}

// Wrap PixInsight's console log around a block of work. Everything the core and
// its processes print lands in the returned string, which is what turns "Script
// error: undefined is not an object" into something diagnosable from Node.
function beginConsoleCapture() {
   try { console.beginLog(); return true; } catch (e) { return false; }
}

function endConsoleCapture(active) {
   if (!active) return "";
   try {
      var text = console.endLog();
      return text ? text.toString() : "";
   } catch (e) {
      return "";
   }
}

function handleRunScript(command) {
   var code = command.parameters.code;
   var capturing = beginConsoleCapture();
   var result;
   try {
      result = eval(code);
   } catch (e) {
      var failLog = endConsoleCapture(capturing);
      var err = new Error("Script error: " + e.message);
      // Carried through to the result file so the caller sees the PixInsight
      // console around the failure, not just the exception message.
      err.consoleOutput = failLog;
      err.scriptStack = e.stack || "";
      throw err;
   }
   var okLog = endConsoleCapture(capturing);
   return {
      status: "success",
      outputs: {
         consoleOutput: String(result !== undefined ? result : "Script executed."),
         consoleLog: okLog
      },
      message: "Script executed successfully"
   };
}

// ============================================================================
// Utility Functions
// ============================================================================

function findWindowByViewId(viewId) {
   var windows = ImageWindow.windows;
   for (var i = 0; i < windows.length; ++i) {
      if (windows[i].mainView.id === viewId) {
         return windows[i];
      }
      // Check previews too
      for (var j = 0; j < windows[i].previews.length; ++j) {
         if (windows[i].previews[j].id === viewId) {
            return windows[i];
         }
      }
   }
   return null;
}

function findViewById(viewId) {
   var windows = ImageWindow.windows;
   for (var i = 0; i < windows.length; ++i) {
      if (windows[i].mainView.id === viewId) {
         return windows[i].mainView;
      }
      for (var j = 0; j < windows[i].previews.length; ++j) {
         if (windows[i].previews[j].id === viewId) {
            return windows[i].previews[j];
         }
      }
   }
   return null;
}

// ============================================================================
// Command Router
// ============================================================================

function dispatchCommand(command) {
   var tool = command.tool;

   // Internal commands
   if (tool === "list_open_images") return handleListOpenImages(command);
   if (tool === "open_image") return handleOpenImage(command);
   if (tool === "save_image") return handleSaveImage(command);
   if (tool === "close_image") return handleCloseImage(command);
   if (tool === "get_image_statistics") return handleGetImageStatistics(command);

   // Processing commands
   if (tool === "run_pixelmath") return handleRunPixelMath(command);
   if (tool === "remove_gradient") return handleRemoveGradient(command);
   if (tool === "color_calibrate") return handleColorCalibrate(command);
   if (tool === "remove_green_cast") return handleRemoveGreenCast(command);
   if (tool === "stretch_image") return handleStretchImage(command);
   if (tool === "apply_curves") return handleApplyCurves(command);
   if (tool === "denoise") return handleDenoise(command);
   if (tool === "sharpen") return handleSharpen(command);
   if (tool === "deconvolve") return handleDeconvolve(command);
   if (tool === "combine_lrgb") return handleCombineLRGB(command);
   if (tool === "blend_narrowband") return handleBlendNarrowband(command);

   // Script execution
   if (tool === "run_script") return handleRunScript(command);

   throw new Error("Unknown tool: " + tool);
}

// ============================================================================
// Main Polling Loop
// ============================================================================

function commandIdFromPath(filePath) {
   var base = File.extractName(filePath);
   return base && base.length > 0 ? base : "unknown";
}

// Result files are the only channel back to Node, so every exit path from a
// command must produce one. A command that dies without a result leaves the
// caller polling until its timeout with nothing to report.
function writeResult(resultObj) {
   var resultPath = RESULTS_DIR + "/" + resultObj.id + ".json";
   try {
      writeTextFile(resultPath, JSON.stringify(resultObj));
      return true;
   } catch (e) {
      console.criticalln("[MCP Watcher] Failed to write result " + resultObj.id + ": " + e.message);
      // Second attempt with a minimal payload: the usual cause is something
      // unserializable in outputs, not a broken filesystem.
      try {
         writeTextFile(resultPath, JSON.stringify({
            id: resultObj.id,
            timestamp: getTimestamp(),
            status: "error",
            error: { message: "Result serialization failed: " + e.message, type: "ResultWriteError" }
         }));
         return true;
      } catch (e2) {
         console.criticalln("[MCP Watcher] Result write retry also failed: " + e2.message);
         return false;
      }
   }
}

function processNextCommand() {
   var files = listJsonFiles(COMMANDS_DIR + "/*.json");
   if (files.length === 0) {
      return false;
   }

   // Sort by filename (timestamp-based UUIDs give roughly chronological order)
   files.sort();

   var filePath = files[0];
   var commandId = commandIdFromPath(filePath);
   var commandJson, command;

   try {
      commandJson = readTextFile(filePath);
      command = JSON.parse(commandJson);
   } catch (e) {
      console.criticalln("[MCP Watcher] Unreadable command file " + filePath + ": " + e.message);
      // The filename is the command id, so the caller can still be told why its
      // command died instead of waiting out the full timeout.
      writeResult({
         id: commandId,
         timestamp: getTimestamp(),
         status: "error",
         duration_ms: 0,
         error: { message: "Malformed command file: " + e.message, type: "CommandParseError" }
      });
      deleteFile(filePath);
      return true;
   }

   if (!command.id) command.id = commandId;

   // Delete the command file BEFORE running the handler. A process that hard-
   // crashes PixInsight would otherwise leave its command in place, and the
   // watcher would re-run it on the next start — crashing again, forever.
   deleteFile(filePath);

   writeHeartbeat("busy", { id: command.id, tool: command.tool, startedAt: getTimestamp() }, g_commandCount);

   var startTime = Date.now();
   var resultObj;

   try {
      console.writeln("[MCP Watcher] Executing: " + command.tool + " (id: " + command.id + ")");
      var handlerResult = dispatchCommand(command);
      resultObj = {
         id: command.id,
         timestamp: getTimestamp(),
         status: handlerResult.status,
         process: command.process,
         duration_ms: Date.now() - startTime,
         outputs: handlerResult.outputs || {},
         message: handlerResult.message || ""
      };
   } catch (e) {
      console.criticalln("[MCP Watcher] Error executing " + command.tool + ": " + e.message);
      resultObj = {
         id: command.id,
         timestamp: getTimestamp(),
         status: "error",
         process: command.process,
         duration_ms: Date.now() - startTime,
         error: {
            message: e.message,
            type: e.name || "Error",
            stack: e.scriptStack || e.stack || "",
            consoleOutput: e.consoleOutput || ""
         }
      };
   }

   if (writeResult(resultObj)) {
      console.writeln("[MCP Watcher] Result written: " + resultObj.status +
         " (" + resultObj.duration_ms + "ms)");
   }

   return true;
}

var g_commandCount = 0;

function runWatcher() {
   ensureDirectory(BRIDGE_DIR);
   ensureDirectory(COMMANDS_DIR);
   ensureDirectory(RESULTS_DIR);
   ensureDirectory(LOGS_DIR);

   // Capture the startup block to a file. Everything PixInsight says while the
   // script loads — deprecation warnings above all — otherwise exists only in the
   // Process Console window, which is invisible in automation mode and to
   // anything on the Node side.
   var startupCapture = beginConsoleCapture();

   console.noteln("===========================================");
   console.noteln("  PixInsight MCP Watcher v" + WATCHER_VERSION);
   console.noteln("  Core:    " + coreVersionString() + " (PJSR V8)");
   console.noteln("  Bridge:  " + BRIDGE_DIR);
   console.noteln("  Ctrl+F11 to abort");
   console.noteln("===========================================");

   // Touch every core API the command loop relies on, so a deprecation warning
   // for any of them lands in the startup log rather than in the middle of a
   // processing run hours later.
   CoreApplication.processEvents();
   System.msleep(1);
   File.searchDirectory(COMMANDS_DIR + "/*.json");

   var startupLog = endConsoleCapture(startupCapture);
   try {
      File.writeTextFile(LOGS_DIR + "/watcher-startup.log", startupLog);
   } catch (e) {
      console.warningln("[MCP Watcher] Could not write the startup log: " + e.message);
   }

   console.show();

   // Announce liveness before the first poll. A caller that starts PixInsight
   // and waits on this file gets a definite answer within seconds instead of
   // guessing from process state whether the script compiled.
   writeHeartbeat("idle", null, 0);

   var SHUTDOWN_FILE = BRIDGE_DIR + "/shutdown";

   function shouldShutdown() {
      if (console.abortRequested) return true;
      if (File.exists(SHUTDOWN_FILE)) {
         try { File.remove(SHUTDOWN_FILE); } catch (e) {}
         return true;
      }
      return false;
   }

   // Main loop. CoreApplication.processEvents() keeps the PixInsight UI responsive; short sleeps
   // between calls keep the idle cost near zero.
   for (;;) {
      CoreApplication.processEvents();

      if (shouldShutdown()) {
         console.warningln("[MCP Watcher] Shutdown requested. Stopping.");
         break;
      }

      var processed = false;
      try {
         processed = processNextCommand();
      } catch (e) {
         // processNextCommand handles its own command errors; reaching here means
         // the loop machinery itself failed (a full disk, a permissions change).
         // Log it and keep polling rather than leaving PixInsight running with a
         // dead watcher, which is indistinguishable from a hang on the Node side.
         console.criticalln("[MCP Watcher] Loop error: " + e.message);
         System.msleep(1000);
      }

      if (processed) {
         g_commandCount++;
         writeHeartbeat("idle", null, g_commandCount);
         // Let the core settle after a command. This used to be 20 cycles of
         // 20ms, which charged 400ms to EVERY call — the single largest term in
         // the bridge's round-trip time, and the agent loop is hundreds of short
         // calls. The yields still happen; there are just fewer of them, and in
         // automation mode there is no window waiting to repaint.
         for (var y = 0; y < 3; ++y) {
            CoreApplication.processEvents();
            System.msleep(20);
            if (shouldShutdown()) break;
         }
      } else {
         writeHeartbeat("idle", null, g_commandCount);
         // ~60ms idle cycle before re-checking for commands. The old 500ms
         // cycle added a quarter-second to every call on average, and the agent
         // loop is hundreds of short calls. The UI yield still runs on the
         // same rhythm, so the UI stays as responsive as it was.
         for (var i = 0; i < 3; ++i) {
            System.msleep(20);
            CoreApplication.processEvents();
            if (shouldShutdown()) break;
         }
      }
   }

   // Clear the heartbeat on the way out so a client can tell a clean shutdown
   // from a crash: no file means stopped, a stale file means something died.
   try { deleteFile(HEARTBEAT_PATH); } catch (e) {}

   console.noteln("[MCP Watcher] Stopped. Processed " + g_commandCount + " command(s).");
}

// ============================================================================
// Entry Point
// ============================================================================

runWatcher();
