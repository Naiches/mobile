// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * "Download my data": the ZIP is fetched into a temporary file, offered through
 * the share sheet, and deleted afterwards. Every failure names its real cause.
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/' }));
const { downloadDataExport, describeExportFailure, DataExportDownloadError } = await import('./data-export-download');
const { cachesEntryFor } = await import('./caches-plaintext-registry');

function harness(opts: { status?: number; body?: string; downloadThrows?: Error; shareThrows?: Error; sharingAvailable?: boolean } = {}) {
  const calls: string[] = [];
  const files = new Set<string>();
  const fs = {
    cacheDirectory: 'file:///cache/',
    downloadAsync: async (url: string, dest: string, o: any) => {
      calls.push(`download ${url} auth=${o?.headers?.Authorization ?? 'none'}`);
      if (opts.downloadThrows) throw opts.downloadThrows;
      files.add(dest);
      return { uri: dest, status: opts.status ?? 200 };
    },
    readAsStringAsync: async () => opts.body ?? '',
    deleteAsync: async (uri: string) => { calls.push(`delete ${uri}`); files.delete(uri); },
  };
  const sharing = {
    isAvailableAsync: async () => opts.sharingAvailable ?? true,
    shareAsync: async (uri: string, o: any) => {
      calls.push(`share ${uri} ${o.mimeType}`);
      expect(files.has(uri)).toBe(true);
      if (opts.shareThrows) throw opts.shareThrows;
    },
  };
  const gate = async (_l: string, _u: string, _fs: any, write: () => Promise<any>) => write();
  return { calls, files, deps: { fs, sharing, gatedWrite: gate, getToken: async () => 'tok' } };
}

const input = { url: 'http://x/api/v1/me/data-export/abc/download?token=t', exportId: 'abc' };

describe('downloadDataExport', () => {
  test('happy path: downloads, shares as a ZIP, then deletes the temp file', async () => {
    const h = harness();
    const r = await downloadDataExport(input, h.deps);
    expect(r).toBe('shared');
    expect(h.calls[0]).toContain('auth=Bearer tok');
    expect(h.calls[1]).toBe('share file:///cache/beebeeb-data-export-abc.zip application/zip');
    expect(h.calls[2]).toBe('delete file:///cache/beebeeb-data-export-abc.zip');
    expect(h.files.size).toBe(0);
  });

  test('the temp file name is covered by the sign-out plaintext purge', () => {
    expect(cachesEntryFor('beebeeb-data-export-abc.zip')?.plaintext).toBe(true);
  });

  test('server says the export expired: names it and removes the error body file', async () => {
    const h = harness({ status: 400, body: '{"error":"Export has expired"}' });
    const err = await downloadDataExport(input, h.deps).catch((e) => e);
    expect(err).toBeInstanceOf(DataExportDownloadError);
    expect(err.message).toBe('The export expired. Request a new one.');
    expect(h.files.size).toBe(0);
  });

  test.each([
    [404, 'This export is no longer available. Request a new one.'],
    [410, 'This export is no longer available. Request a new one.'],
    [401, 'This export link is not valid any more. Request a new one.'],
    [403, 'This export link is not valid any more. Request a new one.'],
    [500, 'The server could not prepare your export. Try again later or request a new one.'],
    [503, 'The server could not prepare your export. Try again later or request a new one.'],
  ])('status %i', async (status, message) => {
    const h = harness({ status, body: '{}' });
    const err = await downloadDataExport(input, h.deps).catch((e) => e);
    expect(err.message).toBe(message);
    expect(h.files.size).toBe(0);
  });

  test('a network failure says so', async () => {
    const h = harness({ downloadThrows: new Error('The Internet connection appears to be offline.') });
    const err = await downloadDataExport(input, h.deps).catch((e) => e);
    expect(err.message).toBe('No connection. Check your network and try again.');
  });

  test('a share-sheet failure is not reported as a download failure, and the file is still deleted', async () => {
    const h = harness({ shareThrows: new Error('cannot present') });
    const err = await downloadDataExport(input, h.deps).catch((e) => e);
    expect(err.message).toBe('Your export was downloaded but the share sheet could not open. Try again.');
    expect(h.files.size).toBe(0);
  });

  test('no share sheet available: reports it, deletes the file', async () => {
    const h = harness({ sharingAvailable: false });
    const err = await downloadDataExport(input, h.deps).catch((e) => e);
    expect(err.message).toBe('Sharing is not available on this device.');
    expect(h.files.size).toBe(0);
  });

  test('a missing download link is a clear error', async () => {
    const h = harness();
    const err = await downloadDataExport({ ...input, url: undefined }, h.deps).catch((e) => e);
    expect(err.message).toBe('The export is not ready yet.');
  });
});

describe('describeExportFailure', () => {
  test('an expired export is recognised from the body, whatever the status', () => {
    expect(describeExportFailure(410, 'Export has expired')).toBe('The export expired. Request a new one.');
  });
});
