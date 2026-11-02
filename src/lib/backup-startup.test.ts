// @ts-nocheck
import { describe, expect, test } from 'bun:test';

import {
  launchBackupWork,
  prepareCategoryBackupForIntent,
  runPreparedCategoryBackup,
  startPhotoBackupBeforeDestinationPreparation,
} from './backup-startup';

describe('backup startup', () => {
  test('a toggle can launch slow work without waiting for it', async () => {
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => { finish = resolve; });
    let started = false;
    const errors: unknown[] = [];

    const returned = launchBackupWork(async () => {
      started = true;
      await slow;
    }, (error) => errors.push(error));

    expect(returned).toBeUndefined();
    expect(started).toBe(true);
    expect(errors).toEqual([]);
    finish();
    await slow;
  });

  test('starts the PhotoKit engine before slow server folder preparation', () => {
    const calls: string[] = [];
    let finishPreparation!: (folderId: string) => void;
    const preparation = new Promise<string>((resolve) => { finishPreparation = resolve; });

    startPhotoBackupBeforeDestinationPreparation({
      startEngine: async () => { calls.push('start-engine'); },
      prepareDestination: async () => {
        calls.push('prepare-destination');
        return preparation;
      },
      configureDestination: async (folderId) => { calls.push(`configure:${folderId}`); },
      onError: () => {},
    });

    expect(calls).toEqual(['start-engine', 'prepare-destination']);
    finishPreparation('camera-folder');
  });

  test('an ON then OFF intent cannot configure the stale photo destination', async () => {
    let current = true;
    let finishPreparation!: (folderId: string) => void;
    const preparation = new Promise<string>((resolve) => { finishPreparation = resolve; });
    const calls: string[] = [];

    startPhotoBackupBeforeDestinationPreparation({
      startEngine: async () => { calls.push('start-engine'); },
      prepareDestination: async () => preparation,
      configureDestination: async (folderId) => { calls.push(`configure:${folderId}`); },
      isCurrent: () => current,
      onError: () => {},
    });

    current = false;
    finishPreparation('stale-folder');
    await preparation;
    await Promise.resolve();

    expect(calls).toEqual(['start-engine']);
  });

  test('an ON then OFF intent cannot bind a category after slow preparation', async () => {
    let current = true;
    let finishPreparation!: (folderId: string) => void;
    const preparation = new Promise<string>((resolve) => { finishPreparation = resolve; });
    const calls: string[] = [];

    const work = prepareCategoryBackupForIntent({
      prepareDestination: async () => preparation,
      configureDestination: async (folderId) => { calls.push(`configure:${folderId}`); },
      bindNative: async () => { calls.push('bind-native'); },
      isCurrent: () => current,
    });

    current = false;
    finishPreparation('stale-folder');

    expect(await work).toBe(false);
    expect(calls).toEqual([]);
  });

  test('observes background errors instead of creating an unhandled rejection', async () => {
    const expected = new Error('folder failed');
    let observed: unknown = null;

    launchBackupWork(async () => { throw expected; }, (error) => { observed = error; });
    await Promise.resolve();

    expect(observed).toBe(expected);
  });

  test('Back up anyway binds/configures first and forwards force to native', async () => {
    const calls: string[] = [];
    await runPreparedCategoryBackup('calendar', { force: true }, {
      prepare: async (kind) => { calls.push(`prepare:${kind}`); },
      run: async (kind, options) => { calls.push(`run:${kind}:force=${options.force}`); },
      refresh: async () => { calls.push('refresh'); },
    });

    expect(calls).toEqual([
      'prepare:calendar',
      'run:calendar:force=true',
      'refresh',
    ]);
  });

  test('a preparation failure aborts Back up anyway before native runs', async () => {
    const expected = new Error('The vault must be unlocked first.');
    const calls: string[] = [];

    await expect(runPreparedCategoryBackup('contacts', { force: true }, {
      prepare: async () => { throw expected; },
      run: async () => { calls.push('run'); },
      refresh: async () => { calls.push('refresh'); },
    })).rejects.toBe(expected);

    expect(calls).toEqual([]);
  });
});
