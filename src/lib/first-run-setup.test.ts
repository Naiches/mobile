// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  ACTIVE_FIRST_RUN_ACCOUNT_KEY,
  advanceFirstRun,
  clearActiveFirstRunAccount,
  completeFirstRun,
  dismissFirstRunCard,
  firstRunSummaryItemLinksToSettings,
  photoPermissionNeedsSettings,
  firstRunPosition,
  initialFirstRunState,
  loadFirstRunState,
  markFirstRunAccountActive,
  markFirstRunItemDone,
  reopenFirstRun,
  resumeFirstRun,
  saveFirstRunState,
  skipFirstRun,
} from './first-run-setup';

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { values.set(key, value); },
    deleteItemAsync: async (key: string) => { values.delete(key); },
  };
}

describe('first-run setup state machine', () => {
  test('photo access opens Settings only after a hard denial, not before the first ask', () => {
    expect(photoPermissionNeedsSettings({
      status: 'undetermined',
      accessPrivileges: 'none',
      canAskAgain: true,
    })).toBe(false);
    expect(photoPermissionNeedsSettings({
      status: 'denied',
      accessPrivileges: 'none',
      canAskAgain: true,
    })).toBe(false);
    expect(photoPermissionNeedsSettings({
      status: 'denied',
      accessPrivileges: 'none',
      canAskAgain: false,
    })).toBe(true);
    expect(photoPermissionNeedsSettings({
      status: 'granted',
      accessPrivileges: 'limited',
      canAskAgain: true,
    })).toBe(false);
  });

  test('starts directly at step 1 of 5 without full-screen tour cards', () => {
    let state = initialFirstRunState();
    expect(state.screen).toBe('app-lock');
    expect(firstRunPosition(state.screen)).toEqual({ position: 1, total: 5 });

    state = skipFirstRun(state);
    expect(state.screen).toBe('photo-backup');
    expect(state.remaining).toEqual(['app-lock']);
  });

  test('Skip on a counted screen skips only that screen and resume starts with the first unfinished item', () => {
    let state = skipFirstRun(initialFirstRunState());
    expect(state.screen).toBe('photo-backup');
    expect(state.remaining).toEqual(['app-lock']);

    state = skipFirstRun(state);
    expect(state.screen).toBe('contacts-calendar');
    expect(state.remaining).toEqual(['app-lock', 'photo-backup']);

    state = skipFirstRun(state);
    expect(state.screen).toBe('files-notifications');
    expect(state.remaining).toEqual(['app-lock', 'photo-backup', 'contacts', 'calendar']);

    state = skipFirstRun(state);
    expect(state.screen).toBe('done');
    expect(state.remaining).toEqual(['app-lock', 'photo-backup', 'contacts', 'calendar', 'notifications']);

    state = completeFirstRun(state);
    expect(state.completed).toBe(true);
    expect(resumeFirstRun(state).screen).toBe('app-lock');
  });

  test('finishing, dismissing the card, completing a skipped item, and reopening are explicit transitions', () => {
    let state = skipFirstRun(initialFirstRunState()); // app lock skipped, now photo
    state = advanceFirstRun(state);
    state = advanceFirstRun(state);
    state = advanceFirstRun(state);
    expect(state.screen).toBe('done');

    state = completeFirstRun(state);
    expect(state.completed).toBe(true);
    expect(state.finishCardDismissed).toBe(false);

    state = dismissFirstRunCard(state);
    expect(state.finishCardDismissed).toBe(true);

    state = markFirstRunItemDone(state, 'app-lock');
    expect(state.remaining).toEqual([]);

    state = reopenFirstRun(state);
    expect(state).toMatchObject({ completed: false, screen: 'app-lock', finishCardDismissed: false });
  });

  test('a skipped summary item links to Settings even when that feature was already enabled', () => {
    const state = skipFirstRun(initialFirstRunState());

    expect(state.remaining).toContain('app-lock');
    expect(firstRunSummaryItemLinksToSettings(state, 'app-lock', true)).toBe(true);
    expect(firstRunSummaryItemLinksToSettings(state, 'photo-backup', true)).toBe(false);
    expect(firstRunSummaryItemLinksToSettings(state, 'notifications', false)).toBe(true);
  });
});

describe('device-local account scoping', () => {
  test('each account has its own durable completion flag; sign-out clears only the active-account marker', async () => {
    const store = memoryStore();
    const accountA = '11111111-1111-1111-1111-111111111111';
    const accountB = '22222222-2222-2222-2222-222222222222';

    const completedA = completeFirstRun({ ...initialFirstRunState(), screen: 'done' });
    await saveFirstRunState(store, accountA, completedA);
    await markFirstRunAccountActive(store, accountA);

    expect((await loadFirstRunState(store, accountA)).completed).toBe(true);
    expect((await loadFirstRunState(store, accountB)).completed).toBe(false);
    expect(store.values.get(ACTIVE_FIRST_RUN_ACCOUNT_KEY)).toBe(accountA);

    await clearActiveFirstRunAccount(store, accountA);
    expect(store.values.has(ACTIVE_FIRST_RUN_ACCOUNT_KEY)).toBe(false);
    expect((await loadFirstRunState(store, accountA)).completed).toBe(true);
  });

  test('a corrupt or old record fails closed to a fresh wizard', async () => {
    const store = memoryStore();
    const account = '33333333-3333-3333-3333-333333333333';
    store.values.set('beebeeb.first_run_setup.v1.33333333-3333-3333-3333-333333333333', '{bad json');
    expect(await loadFirstRunState(store, account)).toEqual(initialFirstRunState());
  });
});
