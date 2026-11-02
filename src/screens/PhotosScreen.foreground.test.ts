// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Photos tab foreground refresh wiring (source-text convention, as in
// FilesScreen.refresh.test.ts): only a real background period refreshes, and
// the silent refreshes never show the pull spinner.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const screen = readFileSync(join(import.meta.dir, 'PhotosScreen.tsx'), 'utf-8');

describe('Photos foreground refresh', () => {
  test('the AppState handler asks the background-return tracker, not a bare active', () => {
    const block = screen.slice(screen.indexOf('createForegroundReturnTracker()'));
    const handler = block.slice(0, block.indexOf('sub.remove()'));
    expect(handler).toContain('createForegroundReturnTracker()');
    expect(handler).toContain('returnedFromBackground(next)');
    expect(handler).not.toContain("next === 'active'");
  });

  test('silent refreshes skip the pull spinner', () => {
    expect(screen).toContain('rereadSources = true, silent = false');
    const fetchBody = screen.slice(screen.indexOf('const fetchPhotos = useCallback'));
    expect(fetchBody.slice(0, 900)).toContain('if (silent && hasVisiblePhotos)');
    expect(screen).toContain('fetchPhotosRef.current(false, false, true, true)');
    expect(screen).toContain('fetchPhotosRef.current(false, false, false, true)');
    expect(screen).toContain('if (!silent) setRefreshing(true)');
  });
});
