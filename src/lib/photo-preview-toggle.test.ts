// @ts-nocheck -- bun runs this; `bun:test` types are not in the Expo tsconfig
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPhotoPreviewToggleCoordinator } from './photo-preview-toggle';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('photo preview toggle coordinator', () => {
  test('rapid off taps open one confirmation until it is cancelled', () => {
    const coordinator = createPhotoPreviewToggleCoordinator();
    const confirmations: Array<{ confirm: () => void; cancel: () => void }> = [];
    const request = () => coordinator.request({
      nextEnabled: false,
      confirmTurnOff: (actions) => { confirmations.push(actions); },
      setOptimistic: () => {},
      run: async () => {},
    });

    expect(Array.from({ length: 10 }, request)).toEqual([
      true, false, false, false, false, false, false, false, false, false,
    ]);
    expect(confirmations).toHaveLength(1);

    confirmations[0].cancel();
    expect(request()).toBe(true);
    expect(confirmations).toHaveLength(2);
  });

  test('confirmed state flips before slow work settles and repeat taps stay ignored', async () => {
    const coordinator = createPhotoPreviewToggleCoordinator();
    const slow = deferred();
    const events: string[] = [];
    let confirmation: { confirm: () => void; cancel: () => void } | null = null;

    expect(coordinator.request({
      nextEnabled: false,
      confirmTurnOff: (actions) => { confirmation = actions; events.push('confirm shown'); },
      setOptimistic: () => { events.push('state off'); },
      run: async () => { events.push('work started'); await slow.promise; events.push('work done'); },
    })).toBe(true);
    expect(events).toEqual(['confirm shown']);

    confirmation!.confirm();
    expect(events).toEqual(['confirm shown', 'state off', 'work started']);
    expect(coordinator.request({
      nextEnabled: true,
      confirmTurnOff: () => {},
      setOptimistic: () => {},
      run: async () => {},
    })).toBe(false);

    slow.resolve();
    await slow.promise;
    await Promise.resolve();
    expect(events).toEqual(['confirm shown', 'state off', 'work started', 'work done']);
  });

  test('turning on is optimistic and single-flight without a confirmation', async () => {
    const coordinator = createPhotoPreviewToggleCoordinator();
    const slow = deferred();
    const events: string[] = [];

    expect(coordinator.request({
      nextEnabled: true,
      confirmTurnOff: () => { events.push('unexpected confirmation'); },
      setOptimistic: () => { events.push('state on'); },
      run: async () => { events.push('work started'); await slow.promise; },
    })).toBe(true);
    expect(events).toEqual(['state on', 'work started']);
    expect(coordinator.isPending()).toBe(true);

    slow.resolve();
    await slow.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(coordinator.isPending()).toBe(false);
  });

  test('the settings screen uses the guard and does no server read before confirmation', () => {
    const screen = readFileSync(join(import.meta.dir, '..', 'screens', 'PhotoPreviewsScreen.tsx'), 'utf8');
    expect(screen).toContain('createPhotoPreviewToggleCoordinator');
    expect(screen).toContain("photo_previews.toggle.confirmation_shown");
    expect(screen).not.toContain('getPhotoPreviewSummary');
    expect(screen).toContain('withAbortablePreviewTimeout');
    expect(screen).toContain('signal => savePhotoPreviewSetting(next, signal)');
    expect(screen).toContain('signal => turnOffPreviews(signal)');
  });
});
