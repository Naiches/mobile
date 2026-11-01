// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  beginJsWorkPhase,
  createJsEventLoopMonitor,
  currentJsWorkPhase,
} from './js-event-loop-monitor';

describe('JS event-loop monitor', () => {
  test('traces drift over 250 ms with the active phase', () => {
    let now = 1_000;
    let tick: (() => void) | null = null;
    const events: Array<{ name: string; fields: Record<string, unknown> }> = [];
    const monitor = createJsEventLoopMonitor({
      now: () => now,
      schedule: (callback) => { tick = callback; return 1; },
      cancel: () => { tick = null; },
      trace: (name, fields) => { events.push({ name, fields }); },
      intervalMs: 100,
      thresholdMs: 250,
    });

    const endPhase = beginJsWorkPhase('files.search-reconcile', () => now);
    monitor.start();
    now = 1_451;
    endPhase();
    tick!();
    monitor.stop();

    expect(events).toEqual([{
      name: 'js.event_loop.stall',
      fields: { lagMs: 351, phase: 'files.search-reconcile' },
    }]);
    expect(currentJsWorkPhase()).toBe('idle');
  });

  test('ignores ordinary timer drift and restores nested phases safely', () => {
    let now = 0;
    let tick: (() => void) | null = null;
    const events: unknown[] = [];
    const monitor = createJsEventLoopMonitor({
      now: () => now,
      schedule: (callback) => { tick = callback; return 1; },
      cancel: () => {},
      trace: (...event) => { events.push(event); },
      intervalMs: 100,
      thresholdMs: 250,
    });
    const endOuter = beginJsWorkPhase('outer', () => now);
    const endInner = beginJsWorkPhase('inner', () => now);
    endOuter();
    expect(currentJsWorkPhase()).toBe('inner');
    monitor.start();
    now = 349;
    tick!();
    endInner();
    monitor.stop();
    expect(events).toEqual([]);
    expect(currentJsWorkPhase()).toBe('idle');
  });

  test('does not report drift equal to the threshold', () => {
    let now = 0;
    let tick: (() => void) | null = null;
    const events: unknown[] = [];
    const monitor = createJsEventLoopMonitor({
      now: () => now,
      schedule: (callback) => { tick = callback; return 1; },
      cancel: () => {},
      trace: (...event) => { events.push(event); },
      intervalMs: 100,
      thresholdMs: 250,
    });
    monitor.start();
    now = 350;
    tick!();
    monitor.stop();
    expect(events).toEqual([]);
  });
});
