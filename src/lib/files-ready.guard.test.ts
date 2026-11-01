// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Wiring for the Files recovery step: the extension and the app share one cache key for "Files
 * asked for authentication", the native module exposes the three calls the post-unlock step
 * uses, and App.tsx runs the step from the registrar and renders the sheet.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const syncEngine = read('targets/file-provider/SyncEngine.swift');
const nativeModule = read('modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift');
const wrapper = read('modules/beebeeb-crypto/src/BeebeebCrypto.ts');
const app = read('src/App.tsx');

describe('Files recovery wiring', () => {
  test('the extension and the app use the same shared cache key for the authentication request', () => {
    const extensionKey = syncEngine.match(/static let authRequiredAtKey = "([^"]+)"/)?.[1];
    const appKey = nativeModule.match(/private let fileProviderAuthRequiredAtKey = "([^"]+)"/)?.[1];
    expect(extensionKey).toBe('files.authRequiredAt');
    expect(appKey).toBe(extensionKey);
  });

  test('the native module exposes read, clear and signal calls, and the wrapper forwards them', () => {
    for (const name of ['getFileProviderAuthRequiredAt', 'clearFileProviderAuthRequired', 'signalFileProviderEnumerators']) {
      expect(nativeModule).toContain(`AsyncFunction("${name}")`);
      expect(wrapper).toContain(`export async function ${name}(`);
    }
  });

  test('the registrar runs the post-unlock step around the default mount, and shows the sheet only from its result', () => {
    const start = app.indexOf('function FileProviderDomainRegistrar(');
    const end = app.indexOf('\nfunction ', start + 10);
    const registrar = app.slice(start, end);
    expect(registrar).toContain('runFilesPostUnlock({');
    expect(registrar).toContain('ensureFilesMountedByDefault(userId)');
    expect(registrar).toContain('mirrorSessionToAppGroup');
    expect(registrar).toContain('signalFileProviderEnumerators');
    expect(registrar).toContain('showReady');
    expect(app).toContain('<FilesReadySheet');
  });

  test('foreground recovery is re-armed only after a real background of at least 30 seconds', () => {
    const start = app.indexOf('function FileProviderDomainRegistrar(');
    const end = app.indexOf('\nfunction ', start + 10);
    const registrar = app.slice(start, end);
    expect(registrar).toContain('createForegroundReturnTracker');
    expect(registrar).toContain('if (returnedFromBackground(next))');
    expect(registrar).not.toContain("if (next === 'active')");
  });

  test('the sheet says what the product asked for and has a Done button', () => {
    const sheet = read('src/components/FilesReadySheet.tsx');
    expect(sheet).toContain('Beebeeb is ready in the Files app');
    expect(sheet).toContain('Done');
    expect(sheet).toContain('testID="files-ready-sheet"');
  });
});
