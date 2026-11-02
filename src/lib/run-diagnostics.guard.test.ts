// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Source guards for the run diagnostics wiring: the exported backup log carries the run history,
 * the app starts the recorder, and the native side records plain numbers only.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('run diagnostics wiring', () => {
  test('the exported backup log includes the run history', () => {
    const source = read('src/screens/BackupInsightsScreen.tsx');
    const handler = source.slice(source.indexOf('const handleExportLog'), source.indexOf('const handleBackupNow'));
    expect(handler).toContain('getRunHistoryLines()');
  });

  test('the app starts the recorder once at boot', () => {
    expect(read('src/App.tsx')).toContain('startRunDiagnostics()');
  });

  test('only memory warnings trim the rebuildable caches', () => {
    const source = read('src/lib/run-diagnostics-runtime.ts');
    expect(source).toContain("AppState.addEventListener('memoryWarning'");
    expect(source).toContain('trimPhotoMemoryCache()');
    expect(source).toContain('trimThumbMemoryCache()');
    expect(read('src/lib/run-diagnostics.ts')).not.toContain("deps.trim('background')");
  });

  test('native run facts hold numbers and flags only, and MetricKit is subscribed at launch', () => {
    const swift = read('modules/beebeeb-crypto/ios/BeebeebAppDelegate.swift');
    const start = swift.slice(swift.indexOf('enum RunDiagnostics'));
    expect(start).toContain('MXMetricManager.shared.add');
    expect(start).toContain('crashDiagnostics');
    expect(start).toContain('phys_footprint');
    // Only exception type and signal numbers are kept from a crash diagnostic.
    expect(start).not.toMatch(/callStackTree|applicationVersion|terminationReason|jsonRepresentation/);
    expect(swift).toContain('RunDiagnostics.start()');
  });
});
