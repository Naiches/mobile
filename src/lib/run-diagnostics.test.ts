// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Why did the last run end? The classifier is pure; the recorder is driven with
 * an in-memory store and fake native facts. Nothing personal may be recorded.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('./runtime-trace', () => ({ recordRuntimeTrace: () => null }));

const {
  RUN_HISTORY_LIMIT,
  classifyLastRun,
  sanitizeRunContext,
  createRunRecorder,
  formatRunHistoryLines,
} = await import('./run-diagnostics');

const base = {
  lastAppState: 'active',
  cleanExit: false,
  crashReports: 0,
  memoryWarnings: 0,
};

describe('classifyLastRun', () => {
  test('a native clean-exit marker wins over the last app state', () => {
    expect(classifyLastRun({ ...base, lastAppState: 'background', cleanExit: true }).end).toBe('clean');
  });

  test('a crash payload is reported as a crash', () => {
    expect(classifyLastRun({ ...base, crashReports: 1 }).end).toBe('crash');
  });

  test('a crash payload outranks the background inference', () => {
    expect(classifyLastRun({ ...base, lastAppState: 'background', crashReports: 2 }).end).toBe('crash');
  });

  test('went to the background and the next launch is cold with no clean exit: killed in the background', () => {
    expect(classifyLastRun({ ...base, lastAppState: 'background' }).end).toBe('background_kill');
  });

  test('last seen in the foreground with no clean exit: ended in the foreground', () => {
    expect(classifyLastRun({ ...base, lastAppState: 'active' }).end).toBe('foreground_kill');
    expect(classifyLastRun({ ...base, lastAppState: 'inactive' }).end).toBe('foreground_kill');
  });

  test('a memory warning before the end is flagged next to any outcome', () => {
    const killed = classifyLastRun({ ...base, lastAppState: 'background', memoryWarnings: 2 });
    expect(killed.end).toBe('background_kill');
    expect(killed.memoryWarningBefore).toBe(true);
    expect(classifyLastRun({ ...base, lastAppState: 'background' }).memoryWarningBefore).toBe(false);
  });
});

describe('sanitizeRunContext', () => {
  test('keeps counts, flags and short state words; drops everything else', () => {
    const out = sanitizeRunContext({
      previewOpen: true,
      uploading: 3,
      backupState: 'running',
      fileName: 'holiday.mov',
      nested: { id: 'abc' },
      list: [1, 2],
      longText: 'x'.repeat(200),
      fileId: 'd3a6a031-d041-460e-ab11-13149bb9af27',
    });
    expect(out).toEqual({ previewOpen: true, uploading: 3, backupState: 'running' });
  });

  test('refuses identifier-shaped and path-shaped strings even under an allowed key', () => {
    expect(sanitizeRunContext({ backupState: 'd3a6a031-d041-460e-ab11-13149bb9af27' })).toEqual({});
    expect(sanitizeRunContext({ backupState: '/var/mobile/a.mov' })).toEqual({});
    expect(sanitizeRunContext({ backupState: 'holiday.mov' })).toEqual({});
  });
});

function makeEnv(initial = null) {
  let stored = initial ? JSON.stringify(initial) : null;
  let footprint = 400;
  let native = { cleanExit: false, crashes: [] };
  let context = { previewOpen: false, uploading: 0, backupState: 'idle' };
  const trimmed: string[] = [];
  const clock = { now: Date.parse('2026-10-31T10:00:00Z') };
  const recorder = createRunRecorder({
    storage: {
      get: async () => stored,
      set: async (value) => { stored = value; },
    },
    native: {
      consumePreviousRun: async () => native,
      memoryFootprintMb: () => footprint,
    },
    context: () => context,
    trim: (reason) => { trimmed.push(reason); },
    now: () => clock.now,
  });
  return {
    recorder,
    clock,
    trimmed,
    stored: () => (stored ? JSON.parse(stored) : null),
    setNative: (n) => { native = n; },
    setFootprint: (n) => { footprint = n; },
    setContext: (c) => { context = c; },
  };
}

describe('run recorder', () => {
  test('the first ever launch has no previous run to report', async () => {
    const env = makeEnv();
    await env.recorder.begin();
    expect(env.stored().history).toEqual([]);
    expect(env.stored().current.lastAppState).toBe('active');
  });

  test('backgrounding records the memory footprint and what was running', async () => {
    const env = makeEnv();
    await env.recorder.begin();
    env.setFootprint(612);
    env.setContext({ previewOpen: true, uploading: 2, backupState: 'running', fileName: 'x.mov' });
    await env.recorder.onAppState('background');
    const current = env.stored().current;
    expect(current.lastAppState).toBe('background');
    expect(current.footprintAtBackgroundMb).toBe(612);
    expect(current.context).toEqual({ previewOpen: true, uploading: 2, backupState: 'running' });
    expect(env.trimmed).toEqual([]);
  });

  test('a cold start after a background run logs "background_kill" with the footprint', async () => {
    const env = makeEnv();
    await env.recorder.begin();
    env.setFootprint(700);
    await env.recorder.onAppState('background');

    env.clock.now += 40_000;
    const second = makeEnv(env.stored());
    second.clock.now = env.clock.now;
    await second.recorder.begin();

    const [record] = second.stored().history;
    expect(record.end).toBe('background_kill');
    expect(record.footprintAtBackgroundMb).toBe(700);
    expect(record.backgroundedForSec).toBeGreaterThanOrEqual(0);
  });

  test('a native crash payload and a memory warning both land on the record', async () => {
    const env = makeEnv();
    await env.recorder.begin();
    await env.recorder.onMemoryWarning();
    expect(env.trimmed).toEqual(['memory_warning']);

    const second = makeEnv(env.stored());
    second.setNative({ cleanExit: false, crashes: [{ exceptionType: 1, signal: 9 }] });
    await second.recorder.begin();
    const [record] = second.stored().history;
    expect(record.end).toBe('crash');
    expect(record.memoryWarnings).toBe(1);
    expect(record.memoryWarningBefore).toBe(true);
    expect(record.crash).toEqual({ exceptionType: 1, signal: 9 });
  });

  test('a crash payload that arrives after launch marks the newest run as a crash', async () => {
    const env = makeEnv();
    await env.recorder.begin();
    await env.recorder.onAppState('background');
    const second = makeEnv(env.stored());
    await second.recorder.begin();
    expect(second.stored().history[0].end).toBe('background_kill');

    second.setNative({ cleanExit: false, crashes: [{ exceptionType: 2, signal: 11 }] });
    await second.recorder.onAppState('active');
    expect(second.stored().history[0].end).toBe('crash');
    expect(second.stored().history[0].crash).toEqual({ exceptionType: 2, signal: 11 });
  });

  test('a clean exit marker is recorded as clean', async () => {
    const env = makeEnv();
    await env.recorder.begin();
    const second = makeEnv(env.stored());
    second.setNative({ cleanExit: true, crashes: [] });
    await second.recorder.begin();
    expect(second.stored().history[0].end).toBe('clean');
  });

  test('coming back to the foreground means a later kill is a foreground end', async () => {
    const env = makeEnv();
    await env.recorder.begin();
    await env.recorder.onAppState('background');
    await env.recorder.onAppState('active');
    const second = makeEnv(env.stored());
    await second.recorder.begin();
    expect(second.stored().history[0].end).toBe('foreground_kill');
  });

  test('keeps only the last 20 runs, newest first', async () => {
    let env = makeEnv();
    await env.recorder.begin();
    for (let i = 0; i < RUN_HISTORY_LIMIT + 5; i++) {
      const next = makeEnv(env.stored());
      next.clock.now = env.clock.now + (i + 1) * 1000;
      await next.recorder.begin();
      env = next;
    }
    const history = env.stored().history;
    expect(history.length).toBe(RUN_HISTORY_LIMIT);
    expect(Date.parse(history[0].startedAt)).toBeGreaterThan(Date.parse(history[1].startedAt));
  });

  test('a stored blob that is not valid is ignored, not fatal', async () => {
    const env = makeEnv();
    const second = makeEnv({ history: 'nope', current: 5 });
    await second.recorder.begin();
    expect(second.stored().history).toEqual([]);
    expect(env).toBeTruthy();
  });

  test('nothing personal is stored: no file names, ids or paths survive in the stored blob', async () => {
    const env = makeEnv();
    await env.recorder.begin();
    env.setContext({
      previewOpen: true,
      backupState: 'running',
      fileName: 'holiday-video.mov',
      fileId: 'd3a6a031-d041-460e-ab11-13149bb9af27',
      path: '/var/mobile/Containers/x',
    });
    await env.recorder.onAppState('background');
    const raw = JSON.stringify(env.stored());
    expect(raw).not.toContain('holiday');
    expect(raw).not.toContain('d3a6a031');
    expect(raw).not.toContain('/var/mobile');
  });
});

describe('formatRunHistoryLines', () => {
  test('lists each run on one line with the outcome, memory warnings and footprint', () => {
    const lines = formatRunHistoryLines([
      {
        startedAt: '2026-10-31T09:00:00.000Z',
        end: 'background_kill',
        memoryWarnings: 2,
        memoryWarningBefore: true,
        footprintAtBackgroundMb: 612,
        backgroundedForSec: 31,
        context: { previewOpen: true, uploading: 2, backupState: 'running' },
      },
      { startedAt: '2026-10-30T09:00:00.000Z', end: 'clean', memoryWarnings: 0, memoryWarningBefore: false },
    ]);
    expect(lines[0]).toBe('--- App runs (last 2) ---');
    expect(lines[1]).toContain('2026-10-31T09:00:00.000Z');
    expect(lines[1]).toContain('ended in background');
    expect(lines[1]).toContain('memory warnings 2');
    expect(lines[1]).toContain('612 MB');
    expect(lines[1]).toContain('preview open');
    expect(lines[1]).toContain('uploading 2');
    expect(lines[2]).toContain('clean exit');
  });

  test('says so when nothing has been recorded yet', () => {
    expect(formatRunHistoryLines([])).toEqual(['--- App runs ---', 'No earlier runs recorded yet.']);
  });
});
