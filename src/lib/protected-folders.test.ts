// @ts-nocheck
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  BACKUPS_PROTECTED_MESSAGE,
  isProtectedBackupsRoot,
  partitionProtectedBackupsRoot,
  setProtectedBackupsRootId,
  subscribeProtectedBackupsRoot,
} from './protected-folders';

beforeEach(() => setProtectedBackupsRootId(null));

describe('isProtectedBackupsRoot', () => {
  test('nothing is protected until the Backups root id is known', () => {
    expect(isProtectedBackupsRoot('abc')).toBe(false);
    expect(isProtectedBackupsRoot(null)).toBe(false);
    expect(isProtectedBackupsRoot(undefined)).toBe(false);
  });

  test('matches by id only, ignoring letter case', () => {
    setProtectedBackupsRootId('EDA1972A-0000-4000-8000-000000000001');
    expect(isProtectedBackupsRoot('eda1972a-0000-4000-8000-000000000001')).toBe(true);
    expect(isProtectedBackupsRoot('eda1972a-0000-4000-8000-000000000002')).toBe(false);
  });

  test('a recreated root replaces the old one; clearing unprotects', () => {
    setProtectedBackupsRootId('old');
    setProtectedBackupsRootId('new');
    expect(isProtectedBackupsRoot('old')).toBe(false);
    expect(isProtectedBackupsRoot('new')).toBe(true);
    setProtectedBackupsRootId(null);
    expect(isProtectedBackupsRoot('new')).toBe(false);
  });

  test('listeners hear changes, and not repeats of the same id', () => {
    let calls = 0;
    const off = subscribeProtectedBackupsRoot(() => { calls += 1; });
    setProtectedBackupsRootId('a');
    setProtectedBackupsRootId('a');
    setProtectedBackupsRootId('b');
    off();
    setProtectedBackupsRootId('c');
    expect(calls).toBe(2);
  });
});

describe('partitionProtectedBackupsRoot', () => {
  test('drops the Backups root from a multi-selection and reports it', () => {
    setProtectedBackupsRootId('root');
    expect(partitionProtectedBackupsRoot(['a', 'root', 'b'])).toEqual({ allowed: ['a', 'b'], skippedProtected: true });
  });

  test('passes everything through when the root is not selected', () => {
    setProtectedBackupsRootId('root');
    expect(partitionProtectedBackupsRoot(['a', 'b'])).toEqual({ allowed: ['a', 'b'], skippedProtected: false });
  });

  test('the note says what happened', () => {
    expect(BACKUPS_PROTECTED_MESSAGE).toBe("Backups is a system folder and can't be deleted.");
  });
});
