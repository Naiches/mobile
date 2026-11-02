// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { createFirstRunActions } from './first-run-actions';

function harness(overrides = {}) {
  const calls: string[] = [];
  const enabled = { photo: false, contacts: false, calendar: false };
  const deps = {
    authenticateDeviceOwner: async () => { calls.push('lock.authenticate'); return { ok: true }; },
    writeLockSetting: async (delayMs: number) => { calls.push(`lock.delay:${delayMs}`); },
    ensurePhotoPermission: async () => { calls.push('photo.permission'); return { granted: true }; },
    readPhotoPermission: async () => ({ status: 'granted', accessPrivileges: 'all' }),
    photoBackupEnabled: () => enabled.photo,
    contactsBackupEnabled: () => enabled.contacts,
    calendarBackupEnabled: () => enabled.calendar,
    togglePhotoBackup: async () => { calls.push('photo.toggle'); enabled.photo = !enabled.photo; },
    toggleContactsBackup: async () => { calls.push('contacts.toggle'); enabled.contacts = !enabled.contacts; },
    toggleCalendarBackup: async () => { calls.push('calendar.toggle'); enabled.calendar = !enabled.calendar; },
    syncBackupCategory: async (kind: string, on: boolean) => { calls.push(`${kind}.sync:${on}`); },
    ensureContactsPermission: async () => { calls.push('contacts.permission'); return true; },
    ensureCalendarPermission: async () => { calls.push('calendar.permission'); return true; },
    ensureFilesMounted: async () => { calls.push('files.mount'); },
    enableNotifications: async () => { calls.push('notifications.permission'); return true; },
    ...overrides,
  };
  return { actions: createFirstRunActions(deps), calls, enabled };
}

describe('first-run steps use the real setting/permission action supplied by the app', () => {
  test('app lock tries device-owner authentication and writes the existing delay setting', async () => {
    const { actions, calls } = harness();
    expect(await actions.tryAppLock()).toEqual({ ok: true });
    await actions.setLockDelay(900_000);
    expect(calls).toEqual(['lock.authenticate', 'lock.delay:900000']);
  });

  test('photo backup asks first, then starts the backup context without waiting for its first run', async () => {
    const { actions, calls } = harness();
    const result = await actions.enablePhotoBackup();
    expect(result).toMatchObject({ granted: true, permission: { accessPrivileges: 'all' } });
    expect(calls).toEqual(['photo.permission', 'photo.toggle']);
  });

  test('a slow photo backup start does not keep the wizard button busy', async () => {
    let release!: () => void;
    const slowStart = new Promise<void>((resolve) => { release = resolve; });
    const { actions } = harness({ togglePhotoBackup: () => slowStart });
    const outcome = await Promise.race([
      actions.enablePhotoBackup(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);
    expect(outcome).toMatchObject({ granted: true });
    release();
  });

  test('a denied photo request never turns backup on', async () => {
    const { actions, calls } = harness({
      ensurePhotoPermission: async () => { calls.push('photo.permission'); return { granted: false }; },
      readPhotoPermission: async () => ({ status: 'denied', accessPrivileges: 'none' }),
    });
    expect(await actions.enablePhotoBackup()).toMatchObject({ granted: false });
    expect(calls).toEqual(['photo.permission']);
  });

  test('contacts and calendar ask permission only while turning on, then start their backup flows', async () => {
    const { actions, calls } = harness();
    expect(await actions.setContactsBackup(true)).toBe(true);
    expect(await actions.setCalendarBackup(true)).toBe(true);
    expect(calls).toEqual([
      'contacts.permission', 'contacts.toggle',
      'calendar.permission', 'calendar.toggle',
    ]);

    calls.length = 0;
    await actions.setContactsBackup(false);
    await actions.setCalendarBackup(false);
    expect(calls).toEqual([
      'contacts.toggle',
      'calendar.toggle',
    ]);
  });

  test('the final feature step mounts Files and uses the shared notification permission flow', async () => {
    const { actions, calls } = harness();
    await actions.ensureFilesMounted();
    expect(await actions.enableNotifications()).toBe(true);
    expect(calls).toEqual(['files.mount', 'notifications.permission']);
  });
});
