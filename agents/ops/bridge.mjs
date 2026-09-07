// ============================================================================
// Bridge communication with PixInsight via file-based IPC
// ============================================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { execFileSync } from 'child_process';

const home = os.homedir();
const DEFAULT_BRIDGE_DIR = path.join(home, '.pixinsight-mcp/bridge');
const DEFAULT_CMD_DIR = path.join(DEFAULT_BRIDGE_DIR, 'commands');
const DEFAULT_RES_DIR = path.join(DEFAULT_BRIDGE_DIR, 'results');
const DEFAULT_HEARTBEAT = path.join(DEFAULT_BRIDGE_DIR, 'watcher.json');

// The watcher rewrites its heartbeat roughly twice a second, including while a
// process runs. Anything older than this means it stopped looping.
const HEARTBEAT_STALE_MS = 30_000;

/**
 * Error thrown when PixInsight is gone: it crashed, or it was never started.
 * Callers catch this specifically to drive crash recovery.
 */
export class BridgeCrashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeCrashError';
    this.isCrash = true;
  }
}

/**
 * Error thrown when PixInsight is running but the watcher is not answering:
 * the script never loaded, or its loop is wedged. Restarting the watcher fixes
 * this; restarting the whole pipeline does not.
 */
export class WatcherUnavailableError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WatcherUnavailableError';
    this.status = status;
  }
}

export function isPixInsightRunning() {
  try {
    const out = execFileSync('/bin/ps', ['ax', '-o', 'command'], { encoding: 'utf-8', timeout: 5000 });
    return out.split('\n').some(l => l.includes('PixInsight.app/Contents/MacOS/PixInsight'));
  } catch {
    return false;
  }
}

function readHeartbeat(heartbeatPath) {
  try {
    return JSON.parse(fs.readFileSync(heartbeatPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Classify what the far side of the bridge is doing. A silent command directory
 * has four very different causes and only one of them is worth retrying, so the
 * caller needs to be told which one it hit.
 */
export function watcherStatus(heartbeatPath = DEFAULT_HEARTBEAT) {
  const running = isPixInsightRunning();
  const hb = readHeartbeat(heartbeatPath);

  if (!hb) {
    return running
      ? { ok: false, reason: 'no-heartbeat',
          detail: 'PixInsight is running but the watcher script is not loaded. Start it with: node scripts/pi-launch.mjs --restart' }
      : { ok: false, reason: 'not-running',
          detail: 'PixInsight is not running. Start it with: node scripts/pi-launch.mjs' };
  }

  const age = Date.now() - Date.parse(hb.timestamp);
  if (!running) {
    return { ok: false, reason: 'crashed', heartbeat: hb,
             detail: `PixInsight crashed about ${Math.round(age / 1000)}s ago, while ${hb.state === 'busy' ? `running ${hb.currentCommand?.tool}` : 'idle'}.` };
  }

  // A busy watcher is blocked inside executeOn and cannot refresh anything, so an
  // old timestamp is the normal state of a long process, not evidence of a hang.
  // The command's own busy timeout is the backstop for a process that never
  // returns; here, "busy and the application is alive" is a healthy answer.
  if (hb.state === 'busy') {
    return { ok: true, reason: 'busy', heartbeat: hb,
             detail: `Watcher busy on ${hb.currentCommand?.tool ?? 'a command'} for ${Math.round(age / 1000)}s.` };
  }

  if (age > HEARTBEAT_STALE_MS) {
    return { ok: false, reason: 'stale', heartbeat: hb,
             detail: `The watcher last reported itself idle ${Math.round(age / 1000)}s ago and has not polled since. PixInsight is running but its script loop stopped.` };
  }
  return { ok: true, reason: hb.state, heartbeat: hb,
           detail: `Watcher v${hb.version} on core ${hb.coreVersion}, state ${hb.state}.` };
}

/**
 * Create a bridge context for communicating with PixInsight.
 * All ops functions take this context as their first argument.
 */
export function createBridgeContext(opts = {}) {
  const cmdDir = opts.cmdDir || DEFAULT_CMD_DIR;
  const resDir = opts.resDir || DEFAULT_RES_DIR;
  const heartbeatPath = opts.heartbeatPath || DEFAULT_HEARTBEAT;
  const logFn = opts.log || console.log;

  // Clean up stale results from previous crashed sessions (older than 5 min)
  try {
    const cutoff = Date.now() - 5 * 60_000;
    for (const f of fs.readdirSync(resDir)) {
      const fp = path.join(resDir, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) { try { fs.unlinkSync(fp); } catch {} }
    }
  } catch {}

  // Deadline for a command that the watcher has NOT started. Once it reports
  // itself busy on our id, this no longer applies: BlurXTerminator on a 6k frame
  // legitimately runs far longer than any fixed timeout worth setting.
  const UNCLAIMED_TIMEOUT_MS = opts.unclaimedTimeoutMs ?? 120_000;
  // Ceiling on a single command the watcher IS working on, as a last resort
  // against a process that will never return.
  const BUSY_TIMEOUT_MS = opts.busyTimeoutMs ?? 60 * 60_000;

  async function send(tool, proc, params, sendOpts) {
    const id = crypto.randomUUID();
    const cmd = {
      id, timestamp: new Date().toISOString(), tool, process: proc,
      parameters: params,
      executeMethod: sendOpts?.exec || 'executeGlobal',
      targetView: sendOpts?.view || null
    };

    // Refuse to queue work for a watcher that cannot run it. Writing the command
    // anyway would leave it sitting in the directory to be picked up by whatever
    // instance starts next, out of order and out of context.
    const pre = watcherStatus(heartbeatPath);
    if (!pre.ok) {
      if (pre.reason === 'not-running' || pre.reason === 'crashed') {
        throw new BridgeCrashError(`Cannot send ${tool}: ${pre.detail}`);
      }
      throw new WatcherUnavailableError(`Cannot send ${tool}: ${pre.detail}`, pre);
    }

    const cmdPath = path.join(cmdDir, id + '.json');
    const resPath = path.join(resDir, id + '.json');
    fs.writeFileSync(cmdPath, JSON.stringify(cmd, null, 2));

    const sentAt = Date.now();
    let claimedAt = null;

    try {
      for (;;) {
        await new Promise(r => setTimeout(r, 500));

        if (fs.existsSync(resPath)) {
          let parsed = null;
          try {
            parsed = JSON.parse(fs.readFileSync(resPath, 'utf-8'));
          } catch {
            // The watcher may be mid-write; look again on the next tick.
            continue;
          }
          if (parsed.status === 'running') continue;
          try { fs.unlinkSync(resPath); } catch {}
          return parsed;
        }

        const status = watcherStatus(heartbeatPath);

        if (status.reason === 'crashed' || status.reason === 'not-running') {
          const during = claimedAt ? ` while running ${tool}` : ` with ${tool} still queued`;
          throw new BridgeCrashError(
            `PixInsight died${during}. ${status.detail} ` +
            `Restart with: node scripts/pi-launch.mjs --restart, then resume with --resume --run-id <runId>`);
        }

        if (status.reason === 'no-heartbeat' || status.reason === 'stale') {
          throw new WatcherUnavailableError(`Bridge lost the watcher during ${tool}. ${status.detail}`, status);
        }

        // The watcher names the command it is working on, so a long process is
        // distinguishable from a command nobody ever picked up.
        if (status.heartbeat?.currentCommand?.id === id) {
          claimedAt = claimedAt ?? Date.now();
        }

        if (!claimedAt && Date.now() - sentAt > UNCLAIMED_TIMEOUT_MS) {
          throw new WatcherUnavailableError(
            `The watcher never picked up ${tool} within ${Math.round(UNCLAIMED_TIMEOUT_MS / 1000)}s, ` +
            `though it reports itself ${status.heartbeat?.state}. ` +
            `Check for a backlog in ${cmdDir}.`, status);
        }

        if (claimedAt && Date.now() - claimedAt > BUSY_TIMEOUT_MS) {
          throw new Error(
            `${tool} has been running in PixInsight for over ` +
            `${Math.round(BUSY_TIMEOUT_MS / 60_000)} minutes with no result. Giving up.`);
        }
      }
    } catch (err) {
      // A command left in the directory would be executed by the next watcher to
      // start, long after its caller gave up on it.
      try { fs.unlinkSync(cmdPath); } catch {}
      throw err;
    }
  }

  async function pjsr(code) {
    const r = await send('run_script', '__script__', { code });
    r.result = r.outputs?.consoleOutput;
    if (r.status !== 'error') r.status = 'ok';
    return r;
  }

  async function listImages() {
    const list = await send('list_open_images', '__internal__', {});
    return list.outputs?.images || [];
  }

  async function detectNewImages(beforeIds) {
    const imgs = await listImages();
    return imgs.filter(i => !beforeIds.includes(i.id));
  }

  /**
   * Quick health check — returns true if PixInsight watcher responds within timeout.
   */
  async function ping(timeoutMs = 10000) {
    try {
      const alive = isPixInsightRunning();
      if (!alive) return false;
      const result = await Promise.race([
        send('list_open_images', '__internal__', {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), timeoutMs))
      ]);
      return result.status !== 'error';
    } catch {
      return false;
    }
  }

  const MEM_WARN_MB = opts.memWarnMB || 4000;
  const MEM_ABORT_MB = opts.memAbortMB || 8000;

  async function checkMemory(stepId, liveImages, onAbort) {
    try {
      const execSync = await getExecSync();
      const out = execSync("ps aux | grep '[P]ixInsight.app' | awk '{s+=$6} END{print s}'").toString().trim();
      const memKB = parseInt(out, 10);
      if (!memKB) return memKB;
      const memMB = Math.round(memKB / 1024);
      if (memMB > MEM_ABORT_MB) {
        logFn(`  [MEMORY] CRITICAL: PixInsight using ${memMB}MB`);
        if (onAbort) await onAbort(stepId);
        return memMB;
      } else if (memMB > MEM_WARN_MB) {
        logFn(`  [MEMORY] WARNING: PixInsight using ${memMB}MB — purging undo history`);
        if (liveImages) {
          for (const [branch, viewId] of Object.entries(liveImages)) {
            await pjsr(`var w = ImageWindow.windowById('${viewId}'); if (!w.isNull) w.purge();`);
          }
        }
        await pjsr('CoreApplication.processEvents();');
        const out2 = execSync("ps aux | grep '[P]ixInsight.app' | awk '{s+=$6} END{print s}'").toString().trim();
        const memMB2 = Math.round(parseInt(out2, 10) / 1024);
        logFn(`  [MEMORY] After purge: ${memMB2}MB`);
        return memMB2;
      } else {
        logFn(`  [memory] ${memMB}MB`);
        return memMB;
      }
    } catch { return 0; }
  }

  function log(msg) { logFn(msg); }

  return { send, pjsr, listImages, detectNewImages, checkMemory, ping, log };
}
