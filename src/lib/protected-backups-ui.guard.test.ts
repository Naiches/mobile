// @ts-nocheck
// Source guard: no Drive path offers delete, rename or move for the protected Backups root.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dir, '..', 'screens', 'FilesScreen.tsx'), 'utf8');

/** Text of `const <name> = useCallback(` up to the next top-level useCallback. */
function handler(name: string): string {
  const start = src.indexOf(`const ${name} = useCallback(`);
  if (start === -1) throw new Error(`handler not found: ${name}`);
  const next = src.indexOf('\n  const ', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('FilesScreen and the protected Backups root', () => {
  test('the long-press menu is built by itemActionOptions with the protected flag', () => {
    expect(src).toContain("from '../lib/file-action-options'");
    expect(handler('handleLongPress')).toContain('itemActionOptions(');
    expect(handler('handleLongPress')).toContain('isProtectedBackupsRoot(item.id)');
  });

  test('the dispatcher refuses Rename, Move and Delete for it as well', () => {
    const body = handler('handleLongPress');
    expect(body).toMatch(/dispatchAction = \(option: string\) => \{\s*if \(isProtectedBackupsRoot\(item\.id\)/);
  });

  test('swipe-to-trash is not offered and not handled for it', () => {
    expect(src).toMatch(/renderRightActions=\{isProtectedRoot \? undefined : renderRightActions\}/);
    expect(handler('handleSwipeDelete')).toContain('isProtectedBackupsRoot(item.id)');
  });

  test('multi-select trash and move skip it and say why', () => {
    for (const name of ['handleBatchTrash', 'handleBatchMove']) {
      expect(handler(name)).toContain('partitionProtectedBackupsRoot(');
      expect(handler(name)).toMatch(/BACKUPS_PROTECTED_(MOVE_)?MESSAGE/);
    }
  });

  test('the move itself drops it too (defence in depth)', () => {
    expect(handler('performMove')).toContain('partitionProtectedBackupsRoot(');
  });
});
