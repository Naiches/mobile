// @ts-nocheck — bun test types are outside the Expo tsconfig.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./BackupInsightsScreen.tsx', import.meta.url), 'utf8');

describe('Backup Insights title and status layout', () => {
  test('clips the scroll viewport below a measured header with a safe first-frame fallback', () => {
    expect(source).toContain('const headerInset = headerHeight || SCROLL_EDGE.chromeFallback;');
    expect(source).toContain("scrollViewport: { flex: 1, overflow: 'hidden' }");
    expect(source).toContain('style={[layout.scrollViewport, { marginTop: headerInset }]}');
    expect(source).not.toContain('contentContainerStyle={[layout.scrollContent, { paddingTop: headerHeight }]}');
  });

  test('renders the newest failed verification attempt as a red failure state', () => {
    expect(source).toContain("lastVerificationAttempt.success ? 'Last verified' : 'Verification failed'");
    expect(source).toContain('lastVerificationAttempt.success ? c.green : c.red');
    expect(source).toContain('timeAgoFromIso(lastVerificationAttempt.at)');
  });
});
