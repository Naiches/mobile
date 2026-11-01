// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

describe('iOS limited-photo access owns its picker prompt', () => {
  test('Expo config preserves PHPhotoLibraryPreventAutomaticLimitedAccessAlert across prebuild', () => {
    const app = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8'));
    expect(app.expo.ios.infoPlist.PHPhotoLibraryPreventAutomaticLimitedAccessAlert).toBe(true);
  });

  test('the checked-in Info.plist disables iOS automatic limited-access alerts', () => {
    const plist = readFileSync(join(ROOT, 'ios/Beebeeb/Info.plist'), 'utf8');
    expect(plist).toMatch(/<key>PHPhotoLibraryPreventAutomaticLimitedAccessAlert<\/key>\s*<true\/>/);
  });
});
