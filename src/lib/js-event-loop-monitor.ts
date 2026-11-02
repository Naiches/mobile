type TimerHandle = ReturnType<typeof setTimeout>;

interface JsEventLoopMonitorOptions {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle | number;
  cancel?: (handle: TimerHandle | number) => void;
  trace: (name: string, fields: Record<string, unknown>) => unknown;
  intervalMs?: number;
  thresholdMs?: number;
}

interface ActivePhase {
  id: number;
  name: string;
  startedAt: number;
}

const activePhases: ActivePhase[] = [];
const completedPhases: Array<ActivePhase & { endedAt: number }> = [];
let nextPhaseId = 0;

const monotonicNow = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

export function currentJsWorkPhase(): string {
  return activePhases.at(-1)?.name ?? 'idle';
}

/** Mark synchronous work as active; the returned function is idempotent. */
export function beginJsWorkPhase(name: string, now: () => number = monotonicNow): () => void {
  const phase = { id: ++nextPhaseId, name, startedAt: now() };
  activePhases.push(phase);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const index = activePhases.findIndex((candidate) => candidate.id === phase.id);
    if (index >= 0) activePhases.splice(index, 1);
    completedPhases.push({ ...phase, endedAt: now() });
    if (completedPhases.length > 50) completedPhases.splice(0, completedPhases.length - 50);
  };
}

function phaseDuring(expectedAt: number, actualAt: number): string {
  const active = [...activePhases]
    .reverse()
    .find((phase) => phase.startedAt <= actualAt);
  if (active) return active.name;
  for (let index = completedPhases.length - 1; index >= 0; index -= 1) {
    const phase = completedPhases[index]!;
    if (phase.startedAt <= actualAt && phase.endedAt >= expectedAt) return phase.name;
  }
  return 'idle';
}

export function createJsEventLoopMonitor(options: JsEventLoopMonitorOptions) {
  const now = options.now ?? monotonicNow;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as TimerHandle));
  const intervalMs = options.intervalMs ?? 100;
  const thresholdMs = options.thresholdMs ?? 250;
  let timer: TimerHandle | number | null = null;
  let expectedAt = 0;
  let running = false;

  const arm = () => {
    expectedAt = now() + intervalMs;
    timer = schedule(tick, intervalMs);
  };
  const tick = () => {
    if (!running) return;
    const actualAt = now();
    const lagMs = Math.max(0, Math.round(actualAt - expectedAt));
    if (lagMs > thresholdMs) {
      options.trace('js.event_loop.stall', {
        lagMs,
        phase: phaseDuring(expectedAt, actualAt),
      });
    }
    arm();
  };

  return {
    start() {
      if (running) return;
      running = true;
      arm();
    },
    stop() {
      running = false;
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
}
