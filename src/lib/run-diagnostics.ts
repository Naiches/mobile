/**
 * Why did the last run end? A small local record of each app run, so a report
 * like "the app restarted after 30 seconds in the background" can be read from
 * the exported log instead of guessed.
 *
 * What is recorded per run (nothing personal: no file names, ids or paths):
 *  - how it ended: a clean exit, a crash (MetricKit crash payload), killed in
 *    the background (inferred), or ended in the foreground;
 *  - whether a memory warning arrived before it ended;
 *  - the memory footprint (phys_footprint) when it went to the background, and
 *    what was running at that moment (preview open, backup and upload counts).
 *
 * The background kill is an inference: the app went to the background and the
 * next launch is a cold start with no clean-exit marker. iOS gives no direct
 * signal for it. A swipe-away from the app switcher looks the same.
 */
import { recordRuntimeTrace } from './runtime-trace';

export const RUN_HISTORY_LIMIT = 20;
export const RUN_HISTORY_STORAGE_KEY = 'beebeeb_run_history_v1';

export type RunEnd = 'clean' | 'crash' | 'background_kill' | 'foreground_kill';
export type RunAppState = 'active' | 'inactive' | 'background';

export interface RunCrashInfo {
  exceptionType?: number;
  signal?: number;
}

/** The facts the previous run left behind, before they are classified. */
export interface RunFacts {
  lastAppState: RunAppState | null;
  cleanExit: boolean;
  crashReports: number;
  memoryWarnings: number;
}

export interface RunClassification {
  end: RunEnd;
  memoryWarningBefore: boolean;
}

export function classifyLastRun(facts: RunFacts): RunClassification {
  const memoryWarningBefore = facts.memoryWarnings > 0;
  if (facts.crashReports > 0) return { end: 'crash', memoryWarningBefore };
  if (facts.cleanExit) return { end: 'clean', memoryWarningBefore };
  if (facts.lastAppState === 'background') return { end: 'background_kill', memoryWarningBefore };
  return { end: 'foreground_kill', memoryWarningBefore };
}

export type RunContext = Record<string, boolean | number | string>;

// Only these keys, and only counts, flags or short state words, can be stored.
const CONTEXT_KEYS = new Set([
  'previewOpen',
  'activeStreams',
  'backupState',
  'waitingToEncrypt',
  'readyToUpload',
  'uploading',
  'failed',
]);
const STATE_WORD = /^[a-z_]{1,24}$/;

export function sanitizeRunContext(input: Record<string, unknown> | null | undefined): RunContext {
  const out: RunContext = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    if (!CONTEXT_KEYS.has(key)) continue;
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.max(0, Math.round(value));
    else if (typeof value === 'string' && STATE_WORD.test(value)) out[key] = value;
  }
  return out;
}

/** The run in progress, persisted as it changes. */
interface CurrentRun {
  startedAt: string;
  lastAppState: RunAppState;
  memoryWarnings: number;
  backgroundedAtMs?: number;
  footprintAtBackgroundMb?: number | null;
  context?: RunContext;
}

export interface RunRecord {
  startedAt: string;
  end: RunEnd;
  memoryWarnings: number;
  memoryWarningBefore: boolean;
  footprintAtBackgroundMb?: number | null;
  backgroundedForSec?: number | null;
  context?: RunContext;
  crash?: RunCrashInfo;
}

interface StoredRuns {
  current: CurrentRun | null;
  history: RunRecord[];
}

export interface PreviousRunNativeFacts {
  cleanExit: boolean;
  crashes: RunCrashInfo[];
}

export interface RunRecorderDeps {
  storage: {
    get: () => Promise<string | null>;
    set: (value: string) => Promise<void>;
  };
  native: {
    consumePreviousRun: () => Promise<PreviousRunNativeFacts>;
    memoryFootprintMb: () => number | null;
  };
  /** What is running right now; sanitized before it is stored. */
  context: () => Record<string, unknown> | null | undefined;
  /** Release what can be rebuilt (image caches and the like). */
  trim: (reason: 'memory_warning') => void;
  now: () => number;
}

function readStored(raw: string | null): StoredRuns {
  if (!raw) return { current: null, history: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<StoredRuns>;
    const history = Array.isArray(parsed.history)
      ? parsed.history.filter((entry): entry is RunRecord => !!entry && typeof entry === 'object' && typeof entry.end === 'string')
      : [];
    const current = parsed.current && typeof parsed.current === 'object' && typeof (parsed.current as CurrentRun).startedAt === 'string'
      ? (parsed.current as CurrentRun)
      : null;
    return { current, history: history.slice(0, RUN_HISTORY_LIMIT) };
  } catch {
    return { current: null, history: [] };
  }
}

function crashInfo(crash: RunCrashInfo | undefined): RunCrashInfo | undefined {
  if (!crash) return undefined;
  const out: RunCrashInfo = {};
  if (typeof crash.exceptionType === 'number') out.exceptionType = crash.exceptionType;
  if (typeof crash.signal === 'number') out.signal = crash.signal;
  return out;
}

export function createRunRecorder(deps: RunRecorderDeps) {
  let state: StoredRuns = { current: null, history: [] };
  let writing: Promise<void> = Promise.resolve();

  const persist = (): Promise<void> => {
    const snapshot = JSON.stringify(state);
    writing = writing.then(() => deps.storage.set(snapshot)).catch(() => {});
    return writing;
  };

  return {
    /** Close the previous run into the history and start a new one. */
    async begin(): Promise<void> {
      state = readStored(await deps.storage.get().catch(() => null));
      const previous = state.current;
      if (previous) {
        const native = await deps.native.consumePreviousRun().catch(
          (): PreviousRunNativeFacts => ({ cleanExit: false, crashes: [] }),
        );
        const { end, memoryWarningBefore } = classifyLastRun({
          lastAppState: previous.lastAppState,
          cleanExit: native.cleanExit,
          crashReports: native.crashes.length,
          memoryWarnings: previous.memoryWarnings,
        });
        const record: RunRecord = {
          startedAt: previous.startedAt,
          end,
          memoryWarnings: previous.memoryWarnings,
          memoryWarningBefore,
        };
        if (previous.footprintAtBackgroundMb != null) record.footprintAtBackgroundMb = previous.footprintAtBackgroundMb;
        if (previous.context) record.context = sanitizeRunContext(previous.context);
        if (previous.lastAppState === 'background' && typeof previous.backgroundedAtMs === 'number') {
          record.backgroundedForSec = Math.max(0, Math.round((deps.now() - previous.backgroundedAtMs) / 1000));
        }
        const crash = crashInfo(native.crashes[0]);
        if (crash) record.crash = crash;
        state.history = [record, ...state.history].slice(0, RUN_HISTORY_LIMIT);
        recordRuntimeTrace('app.last_run', {
          end,
          memoryWarningBefore,
          footprintAtBackgroundMb: record.footprintAtBackgroundMb ?? null,
          backgroundedForSec: record.backgroundedForSec ?? null,
        });
      }
      state.current = {
        startedAt: new Date(deps.now()).toISOString(),
        lastAppState: 'active',
        memoryWarnings: 0,
      };
      await persist();
    },

    async onAppState(next: string): Promise<void> {
      const current = state.current;
      if (!current) return;
      if (next === 'background') {
        current.lastAppState = 'background';
        current.backgroundedAtMs = deps.now();
        current.footprintAtBackgroundMb = deps.native.memoryFootprintMb();
        current.context = sanitizeRunContext(deps.context());
        recordRuntimeTrace('app.background', {
          footprintMb: current.footprintAtBackgroundMb ?? null,
          ...current.context,
        });
        // Persist first: the process can be suspended right after this callback.
        const saved = persist();
        await saved;
      } else if (next === 'active' || next === 'inactive') {
        if (next === 'active') await this.attachLateCrash();
        if (current.lastAppState === next) return;
        // Returning from the background: a later kill is a foreground end.
        current.lastAppState = next;
        if (next === 'active') delete current.backgroundedAtMs;
        await persist();
      }
    },

    /**
     * MetricKit delivers a crash payload some time after the launch that follows the crash, so it
     * can arrive after `begin`. Attach it to the newest record and mark that run as a crash.
     */
    async attachLateCrash(): Promise<void> {
      const latest = state.history[0];
      if (!latest || latest.end === 'crash') return;
      const native = await deps.native.consumePreviousRun().catch(() => null);
      const crash = crashInfo(native?.crashes[0]);
      if (!crash) return;
      latest.end = 'crash';
      latest.crash = crash;
      await persist();
    },

    async onMemoryWarning(): Promise<void> {
      const current = state.current;
      if (!current) return;
      current.memoryWarnings += 1;
      recordRuntimeTrace('app.memory_warning', {
        count: current.memoryWarnings,
        footprintMb: deps.native.memoryFootprintMb(),
      });
      deps.trim('memory_warning');
      await persist();
    },

    history(): RunRecord[] {
      return state.history;
    },
  };
}

const END_TEXT: Record<RunEnd, string> = {
  clean: 'clean exit',
  crash: 'crashed',
  background_kill: 'ended in background (killed while in the background, inferred)',
  foreground_kill: 'ended in foreground (no clean exit)',
};

export function formatRunHistoryLines(history: RunRecord[]): string[] {
  if (history.length === 0) return ['--- App runs ---', 'No earlier runs recorded yet.'];
  const lines = [`--- App runs (last ${history.length}) ---`];
  for (const run of history) {
    const parts = [run.startedAt, END_TEXT[run.end] ?? run.end];
    parts.push(`memory warnings ${run.memoryWarnings}`);
    if (run.footprintAtBackgroundMb != null) parts.push(`${run.footprintAtBackgroundMb} MB at background`);
    if (run.backgroundedForSec != null) parts.push(`${run.backgroundedForSec}s in background before relaunch`);
    if (run.crash) parts.push(`crash signal ${run.crash.signal ?? '?'} type ${run.crash.exceptionType ?? '?'}`);
    const context = run.context ?? {};
    if (context.previewOpen === true) parts.push('preview open');
    for (const key of ['activeStreams', 'uploading', 'waitingToEncrypt', 'readyToUpload', 'failed'] as const) {
      const value = context[key];
      if (typeof value === 'number' && value > 0) parts.push(`${key === 'activeStreams' ? 'streams' : key} ${value}`);
    }
    if (typeof context.backupState === 'string') parts.push(`backup ${context.backupState}`);
    lines.push(parts.join(' · '));
  }
  return lines;
}
