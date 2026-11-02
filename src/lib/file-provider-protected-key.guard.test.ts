// @ts-nocheck
// The app writes the protected Backups root id under the same sync_state key the extension reads.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const item = readFileSync(join(ROOT, 'targets', 'file-provider', 'FileProviderItem.swift'), 'utf8');
const module = readFileSync(join(ROOT, 'modules', 'beebeeb-crypto', 'ios', 'BeebeebCryptoModule.swift'), 'utf8');

describe('protected Backups root key', () => {
  test('extension and app module use the same sync_state key', () => {
    const key = /static let protectedBackupsRootKey = "([^"]+)"/.exec(item)?.[1];
    expect(key).toBeTruthy();
    expect(module).toContain(`let fileProviderProtectedBackupsRootKey = "${key}"`);
    expect(module).toContain('AsyncFunction("setFileProviderProtectedFolder")');
  });
});
