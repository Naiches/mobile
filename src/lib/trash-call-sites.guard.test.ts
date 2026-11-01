// @ts-nocheck
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('every user-facing move-to-Trash surface routes through the shared helper', () => {
  for (const path of ['screens/FilesScreen.tsx', 'screens/PhotosScreen.tsx', 'screens/PreviewScreen.tsx']) {
    const text = source(path);
    expect(text, path).toContain('moveToTrashWithUndo');
    expect(text, path).not.toMatch(/\btrashFiles\s*\(/);
  }
  const files = source('screens/FilesScreen.tsx');
  expect(files).not.toMatch(/await deleteFile\(item\.id\)/);
});

test('Drive renders the Trash count row only through the shared root-only contract', () => {
  const files = source('screens/FilesScreen.tsx');
  expect(files).toContain('shouldShowTrashRow');
  expect(files).toContain('testID="drive-trash-row"');
  expect(files).toContain('trashRowLabel(trashCount)');
});
