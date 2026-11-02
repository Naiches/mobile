// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { ensureContactsPermission } from './contacts-permissions';

describe('ensureContactsPermission', () => {
  test('an existing grant does not prompt again', async () => {
    const calls: string[] = [];
    expect(await ensureContactsPermission({
      getPermissionsAsync: async () => { calls.push('get'); return { status: 'granted' }; },
      requestPermissionsAsync: async () => { calls.push('request'); return { status: 'granted' }; },
    })).toBe(true);
    expect(calls).toEqual(['get']);
  });

  test('an explicit enable requests once and returns the answer', async () => {
    const calls: string[] = [];
    expect(await ensureContactsPermission({
      getPermissionsAsync: async () => { calls.push('get'); return { status: 'undetermined' }; },
      requestPermissionsAsync: async () => { calls.push('request'); return { granted: false }; },
    })).toBe(false);
    expect(calls).toEqual(['get', 'request']);
  });
});
