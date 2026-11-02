// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const screen = readFileSync(new URL('./PhotosScreen.tsx', import.meta.url), 'utf8');

describe('Photos pull-to-refresh', () => {
  test('every visible fetch has one deadline and leaves a visible Retry on failure', () => {
    expect(screen).toContain('createPhotoRefreshDeadline');
    expect(screen).toContain('const refreshDeadline = createPhotoRefreshDeadline();');
    expect(screen).not.toContain('isRefresh ? createPhotoRefreshDeadline() : null');
    expect(screen).toContain('refreshDeadline.wait');
    expect(screen).toContain('PhotoRefreshTimeoutError');
    expect(screen).toContain("'Photos could not refresh in time. Try again.'");
    expect(screen).toContain('>Retry</Text>');
  });
});
