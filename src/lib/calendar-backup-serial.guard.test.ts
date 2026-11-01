// @ts-nocheck -- Bun source guard for the native Calendar backup pipeline.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(import.meta.dir, '../../modules/beebeeb-crypto/ios/CalendarBackupManager.swift'),
  'utf8',
);
const backup = source.slice(
  source.indexOf('  func backup(force: Bool = false)'),
  source.indexOf('  func backupNow(force: Bool = false)'),
);

describe('Calendar backup uploads asynchronously in serial order', () => {
  test('the run uses the shared serial pipeline and never parks a worker', () => {
    expect(backup).toContain('AsyncSerialPipeline.forEach(');
    expect(backup).not.toContain('DispatchGroup');
    expect(backup).not.toMatch(/\.wait\s*\(/);
  });
});
