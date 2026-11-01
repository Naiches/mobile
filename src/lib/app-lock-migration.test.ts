// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  nativeVaultAuthConfirmsFace,
  runPasscodeKeyMigration,
  PASSCODE_MIGRATION_KEY,
} from './app-lock-migration';

function makeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => { data.set(k, v); },
  };
}

describe('runPasscodeKeyMigration', () => {
  test('uses a new marker so passcode-only upgrade keys are rewrapped with user presence', () => {
    expect(PASSCODE_MIGRATION_KEY).toBe('beebeeb_lock_user_presence_migrated_v1');
  });

  test('runs once after an unlock and records it', async () => {
    const store = makeStore();
    const calls: boolean[] = [];
    await runPasscodeKeyMigration({ ...store, setBiometricRequirement: async (r) => { calls.push(r); } });
    expect(calls).toEqual([false]);
    expect(store.data.get(PASSCODE_MIGRATION_KEY)).toBe('1');
    await runPasscodeKeyMigration({ ...store, setBiometricRequirement: async (r) => { calls.push(r); } });
    expect(calls).toEqual([false]);
  });

  test('a failure is swallowed, not recorded, and retried next time', async () => {
    const store = makeStore();
    let attempts = 0;
    const failing = async () => { attempts++; throw new Error('rewrap failed'); };
    await expect(runPasscodeKeyMigration({ ...store, setBiometricRequirement: failing })).resolves.toBeUndefined();
    expect(store.data.has(PASSCODE_MIGRATION_KEY)).toBe(false);
    await runPasscodeKeyMigration({ ...store, setBiometricRequirement: async () => { attempts++; } });
    expect(attempts).toBe(2);
    expect(store.data.get(PASSCODE_MIGRATION_KEY)).toBe('1');
  });

  test('a storage failure never throws', async () => {
    await expect(runPasscodeKeyMigration({
      get: async () => { throw new Error('store down'); },
      set: async () => { throw new Error('store down'); },
      setBiometricRequirement: async () => {},
    })).resolves.toBeUndefined();
  });

  test('concurrent unlock completions share one rewrap', async () => {
    const store = makeStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const deps = {
      ...store,
      setBiometricRequirement: async () => { calls += 1; await gate; },
    };
    const first = runPasscodeKeyMigration(deps);
    const second = runPasscodeKeyMigration(deps);
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(store.data.get(PASSCODE_MIGRATION_KEY)).toBe('1');
  });
});

describe('nativeVaultAuthConfirmsFace', () => {
  test('does not treat the one-time legacy passcode unlock as Face ID consent', () => {
    expect(nativeVaultAuthConfirmsFace({
      accessControlAlreadyCurrent: false,
      explicitAuthRequired: false,
      vaultOpened: true,
    })).toBe(false);
  });

  test('confirms only a current native Face-first vault unlock', () => {
    expect(nativeVaultAuthConfirmsFace({
      accessControlAlreadyCurrent: true,
      explicitAuthRequired: false,
      vaultOpened: true,
    })).toBe(true);
    expect(nativeVaultAuthConfirmsFace({
      accessControlAlreadyCurrent: true,
      explicitAuthRequired: true,
      vaultOpened: true,
    })).toBe(false);
    expect(nativeVaultAuthConfirmsFace({
      accessControlAlreadyCurrent: true,
      explicitAuthRequired: false,
      vaultOpened: false,
    })).toBe(false);
    expect(nativeVaultAuthConfirmsFace({
      accessControlAlreadyCurrent: true,
      explicitAuthRequired: false,
      vaultOpened: true,
      viaSoftwareFallback: true,
    })).toBe(false);
  });
});
