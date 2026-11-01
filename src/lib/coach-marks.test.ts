// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  beginCoachMarks,
  COACH_MARK_COPY,
  coachMarkTargetForStep,
  coachMarksCanPresentOnRoute,
  coachMarksStateKey,
  initialCoachMarksState,
  loadCoachMarksState,
  nextCoachMark,
  saveCoachMarksState,
  skipCoachMarks,
} from './coach-marks';
import {
  coachMarkDimCells,
  coachMarkLayoutSignature,
  coachMarkPrimaryRect,
  coachMarkTabRect,
  measureCoachMarkTarget,
} from './coach-mark-layout';

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { values.set(key, value); },
  };
}

describe('coach marks state machine', () => {
  test('shows Drive, Photos, Shared and Settings once, in order', () => {
    let state = beginCoachMarks(initialCoachMarksState());
    expect(state).toMatchObject({ status: 'active', step: 'drive' });
    state = nextCoachMark(state);
    expect(state.step).toBe('photos');
    state = nextCoachMark(state);
    expect(state.step).toBe('shared');
    state = nextCoachMark(state);
    expect(state.step).toBe('settings');
    state = nextCoachMark(state);
    expect(state).toMatchObject({ status: 'done', step: null });
  });

  test('skip is permanent until an explicit setup replay begins', () => {
    const skipped = skipCoachMarks(beginCoachMarks(initialCoachMarksState()));
    expect(nextCoachMark(skipped)).toEqual(skipped);
    expect(beginCoachMarks(skipped)).toEqual(skipped);
    expect(beginCoachMarks(initialCoachMarksState())).toMatchObject({ status: 'active', step: 'drive' });
  });

  test('defers a newly queued Drive tip while a completed setup opens Settings', () => {
    const drive = beginCoachMarks(initialCoachMarksState());
    expect(coachMarksCanPresentOnRoute(drive, 'Settings')).toBe(false);
    expect(coachMarksCanPresentOnRoute(drive, 'FirstRunSetup')).toBe(false);
    expect(coachMarksCanPresentOnRoute(drive, 'Drive')).toBe(true);
    expect(coachMarksCanPresentOnRoute({ ...drive, step: 'settings' }, 'Settings')).toBe(true);
  });

  test('persists independently for each account on this device', async () => {
    const store = memoryStore();
    const doneA = skipCoachMarks(beginCoachMarks(initialCoachMarksState()));
    await saveCoachMarksState(store, 'account-a', doneA);

    expect(await loadCoachMarksState(store, 'account-a')).toEqual(doneA);
    expect(await loadCoachMarksState(store, 'account-b')).toEqual(initialCoachMarksState());
    expect(store.values.has(coachMarksStateKey('account-a'))).toBe(true);
    expect(store.values.has(coachMarksStateKey('account-b'))).toBe(false);
  });

  test('each tip uses one short sentence', () => {
    for (const copy of Object.values(COACH_MARK_COPY)) {
      expect(copy.body.match(/[.!?](?:\s|$)/g)).toHaveLength(1);
    }
  });

  test('each tip names at most one real control, and Drive means the Files tab', () => {
    expect(coachMarkTargetForStep('drive')).toBeNull();
    expect(coachMarkTargetForStep('photos')).toBe('photos-sources');
    expect(coachMarkTargetForStep('shared')).toBeNull();
    expect(coachMarkTargetForStep('settings')).toBeNull();
  });
});

describe('coach mark geometry', () => {
  test('anchors the four main native tabs beside the separate Search circle', () => {
    const centers = (['drive', 'shared', 'photos', 'settings'] as const).map((step) => {
      const rect = coachMarkTabRect(step, 440, 956, 34);
      return rect.x + rect.width / 2;
    });
    expect(centers).toEqual([67, 145, 223, 301]);
  });

  test('anchors stock five-tab bars with equal-width slots', () => {
    const centers = (['drive', 'shared', 'photos', 'settings'] as const).map((step) => {
      const rect = coachMarkTabRect(step, 390, 844, 34, 'equal-five');
      return rect.x + rect.width / 2;
    });
    expect(centers).toEqual([39, 117, 195, 273]);
  });

  test('a stale native target cannot block the tab fallback forever', async () => {
    const started = Date.now();
    const result = await measureCoachMarkTarget({ measureInWindow: () => {} }, 5);
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(100);
  });

  test('a measured control replaces its tab fallback instead of creating a second target', () => {
    const tab = { x: 20, y: 700, width: 50, height: 50 };
    const measured = { x: 300, y: 40, width: 60, height: 60 };
    expect(coachMarkPrimaryRect(tab, measured)).toEqual(measured);
    expect([coachMarkPrimaryRect(tab, measured)]).toHaveLength(1);
    expect(coachMarkPrimaryRect(tab, null)).toEqual(tab);
  });

  test('dimming cells leave the one resolved target uncovered', () => {
    const holes = [{ x: 300, y: 700, width: 60, height: 60 }];
    const cells = coachMarkDimCells(390, 844, holes);
    for (const hole of holes) {
      const centerX = hole.x + hole.width / 2;
      const centerY = hole.y + hole.height / 2;
      expect(cells.some((cell) => centerX >= cell.x && centerX <= cell.x + cell.width && centerY >= cell.y && centerY <= cell.y + cell.height)).toBe(false);
    }
  });

  test('font scale and either window dimension invalidate measured layout', () => {
    const base = coachMarkLayoutSignature({ width: 390, height: 844, fontScale: 1 }, { top: 59, right: 0, bottom: 34, left: 0 });
    expect(coachMarkLayoutSignature({ width: 390, height: 844, fontScale: 2.35 }, { top: 59, right: 0, bottom: 34, left: 0 })).not.toBe(base);
    expect(coachMarkLayoutSignature({ width: 844, height: 390, fontScale: 1 }, { top: 0, right: 59, bottom: 21, left: 59 })).not.toBe(base);
  });
});
