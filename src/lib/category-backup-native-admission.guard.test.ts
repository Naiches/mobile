// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');

describe('category backup native admission', () => {
  test('manual runs bind without auto-running and require native started admission', () => {
    const bridge = readFileSync(join(root, 'modules/beebeeb-crypto/src/BeebeebCrypto.ts'), 'utf8');
    const module = readFileSync(join(root, 'modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift'), 'utf8');

    expect(bridge).toContain('prepareContactsBackup');
    expect(bridge).toContain('prepareCalendarBackup');
    expect(bridge).toContain("admission === 'started'");
    expect(module).toContain('AsyncFunction("prepareContactsBackup")');
    expect(module).toContain('AsyncFunction("prepareCalendarBackup")');
    expect(module).toContain('return ContactsBackupManager.shared.backupNow');
    expect(module).toContain('return CalendarBackupManager.shared.backupNow');
  });
});
