// @ts-nocheck -- bun:test types are intentionally outside the Expo tsconfig.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8');

test('coach marks discard stale bubble and target measurements for the same step', () => {
  const source = read('components/first-run/CoachMarks.tsx');
  expect(source).toContain('bubbleLayoutKey');
  expect(source).toContain('bubbleMeasuredLayout === bubbleLayoutKey');
  expect(source).toContain('measuredTarget.layoutSignature === layoutSignature');
  expect(source).toContain('readyLayout === bubbleLayoutKey');
  expect(source).toContain('key={bubbleLayoutKey}');
});

test('screens with measured floating headers invalidate their own layout caches', () => {
  const settings = read('screens/SettingsScreen.tsx');
  const photos = read('screens/PhotosScreen.tsx');
  expect(settings).toContain('key={`settings-categories-${screenLayoutSignature}`}');
  expect(settings).toContain('setHeaderHeight(0)');
  expect(photos).toContain('key={`photos-header-${screenLayoutSignature}`}');
  expect(photos).toContain('key={`device-photos-${fontScale}`}');
  expect(photos).toContain('setHeaderHeight(0)');
});
