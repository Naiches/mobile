// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileRowSwipeHitSlop, IOS_NATIVE_BACK_EDGE_WIDTH } from '../lib/file-row-swipe';

const source = readFileSync(join(import.meta.dir, 'FilesScreen.tsx'), 'utf8');
const fileRowSource = source.slice(
  source.indexOf('const FileRowItem ='),
  source.indexOf('// File grid item'),
);

describe('file row swipe gesture ownership', () => {
  test('leaves the iOS back-gesture edge outside the row pan handler', () => {
    expect(fileRowSwipeHitSlop('ios')).toEqual({ left: -IOS_NATIVE_BACK_EDGE_WIDTH });
    expect(fileRowSource).toContain('hitSlop={fileRowSwipeHitSlop(Platform.OS)}');
  });

  test('keeps both interior row swipe actions', () => {
    expect(fileRowSwipeHitSlop('android')).toBeUndefined();
    expect(fileRowSource).toContain('renderLeftActions={renderLeftActions}');
    expect(fileRowSource).toContain('renderRightActions={isProtectedRoot ? undefined : renderRightActions}');
  });
});
