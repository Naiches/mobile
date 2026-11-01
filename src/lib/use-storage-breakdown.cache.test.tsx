// @ts-nocheck
/**
 * Round-1 finding 23: the Storage screen must write freshly decrypted names
 * through to the versioned name cache, and retain the complete snapshot for
 * the current app session (the disk cache deliberately caps itself at 20k).
 */
import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

// The real >20k case deliberately crosses 201 event-loop yields. The suite's
// default 5s budget can be exhausted when the isolated runner has six other
// CPU-heavy test processes active, and a timeout inside `act` then poisons the
// following tests with an overlapping act. Keep the assertion wait bounded,
// but leave a separate cleanup margin around it.
setDefaultTimeout(30_000);

const ledger = {
  files: [] as any[],
  diskCache: {} as Record<string, { name: string; mime: string | null; version: number }>,
  decryptCalls: [] as Array<Array<{ fileId: string; nameEncrypted: string }>>,
  decryptImpl: async (_items: Array<{ fileId: string; nameEncrypted: string }>) => [] as any[],
  saves: [] as Array<{
    cache: Record<string, { name: string; mime: string | null; version: number }>;
    epoch: unknown;
  }>,
};

mock.module('./file-index-loader', () => ({
  loadFileIndex: async () => ({ files: ledger.files }),
}));

mock.module('./name-cache', () => ({
  loadNameCache: async () => ({ ...ledger.diskCache }),
  scheduleSaveNameCache: (cache: typeof ledger.diskCache, epoch: unknown) => {
    ledger.saves.push({ cache, epoch });
  },
}));

const decryptNames = async (items: Array<{ fileId: string; nameEncrypted: string }>) => {
  ledger.decryptCalls.push(items);
  return ledger.decryptImpl(items);
};
const cryptoValue = { isUnlocked: true, decryptNames };
mock.module('./crypto-context', () => ({ useCrypto: () => cryptoValue }));
mock.module('./protected-folders', () => ({ getProtectedBackupsRootId: () => null }));

const { useStorageBreakdown } = await import('./use-storage-breakdown');
const { advanceAccountEpoch, isCurrentAccountEpoch } = await import('./account-epoch');

function folder(id: string, version: number) {
  return {
    id,
    name_encrypted: `sealed:${id}:${version}`,
    size_bytes: 0,
    is_folder: true,
    chunk_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version_number: version,
    parent_id: null,
  };
}

function mediaFile(id: string, parentId: string) {
  return {
    id,
    name_encrypted: `sealed:${id}`,
    size_bytes: 10,
    is_folder: false,
    is_media: true,
    chunk_count: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version_number: 1,
    parent_id: parentId,
  };
}

const published: any[] = [];
const mounted = new Set<any>();
function Probe() {
  published.push(useStorageBreakdown(10));
  return null;
}

async function mount() {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mounted.add(renderer);
  return renderer;
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  if (!predicate()) throw new Error(`Timed out waiting for ${message}`);
}

async function unmount(renderer: any) {
  if (!mounted.delete(renderer)) return;
  await act(async () => { renderer.unmount(); });
}

describe('round-1 #23 — Storage breakdown name-cache reuse', () => {
  beforeEach(() => {
    // The hook's session cache is account-scoped; this is also test isolation.
    advanceAccountEpoch();
    ledger.files = [];
    ledger.diskCache = {};
    ledger.decryptCalls = [];
    ledger.decryptImpl = async () => [];
    ledger.saves = [];
    cryptoValue.isUnlocked = true;
    published.length = 0;
  });

  afterEach(async () => {
    // Always cancel hook work, including when an assertion throws midway
    // through a two-mount test. Otherwise its timer/decrypt continuation can
    // mutate the next test's ledger and create overlapping `act()` calls.
    for (const renderer of [...mounted]) await unmount(renderer);
    advanceAccountEpoch();
    await act(async () => { await Promise.resolve(); });
  });

  test('writes learned names and MIME types through with the row version', async () => {
    ledger.files = [folder('documents', 7)];
    ledger.decryptImpl = async () => [{ name: 'Documents', mimeType: 'inode/directory' }];

    const renderer = await mount();
    await waitFor(() => ledger.saves.length === 1, 'the versioned name-cache save');

    expect(ledger.saves[0].cache).toEqual({
      documents: { name: 'Documents', mime: 'inode/directory', version: 7 },
    });
    expect(isCurrentAccountEpoch(ledger.saves[0].epoch)).toBe(true);
    await unmount(renderer);
  });

  test('rejects a stale disk/session entry when version_number changes', async () => {
    ledger.files = [folder('renamed', 1)];
    ledger.decryptImpl = async () => [{ name: 'Before rename', mimeType: null }];
    let renderer = await mount();
    await waitFor(() => ledger.saves.length === 1, 'the first name-cache save');
    await unmount(renderer);

    ledger.diskCache = ledger.saves[0].cache;
    ledger.files = [folder('renamed', 2)];
    ledger.decryptImpl = async () => [{ name: 'After rename', mimeType: null }];
    renderer = await mount();
    await waitFor(() => ledger.saves.length === 2, 'the renamed name-cache save');

    expect(ledger.decryptCalls).toHaveLength(2);
    expect(ledger.saves[1].cache.renamed).toEqual({
      name: 'After rename', mime: null, version: 2,
    });
    await unmount(renderer);
  });

  test('reuses the session entry omitted by the 20,000-entry persisted cap', async () => {
    const count = 20_001;
    ledger.files = Array.from({ length: count }, (_, i) => folder(`folder-${i}`, 1));
    ledger.decryptImpl = async (items) => items.map(({ fileId }) => ({
      name: `Name ${fileId}`,
      mimeType: null,
    }));

    let renderer = await mount();
    await waitFor(
      () => Object.keys(ledger.saves.at(-1)?.cache ?? {}).length === count,
      'the complete session snapshot',
      20_000,
    );
    const completeSnapshot = ledger.saves.at(-1)!.cache;
    expect(Object.keys(completeSnapshot)).toHaveLength(count);
    const firstVisitCalls = ledger.decryptCalls.length;
    await unmount(renderer);

    // name-cache.ts keeps the newest 20k entries on disk, dropping folder-0.
    ledger.diskCache = Object.fromEntries(Object.entries(completeSnapshot).slice(1));
    const publicationsBeforeRemount = published.length;
    renderer = await mount();
    await waitFor(
      () => published.slice(publicationsBeforeRemount).some((value) => value !== null),
      'the second Storage breakdown',
      20_000,
    );
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(ledger.decryptCalls).toHaveLength(firstVisitCalls);
    await unmount(renderer);
  });

  test('an epoch advance during decrypt prevents publication, persistence, and session reuse', async () => {
    ledger.files = [folder('backup-root', 3), mediaFile('photo', 'backup-root')];
    let resolveDecrypt!: (value: any[]) => void;
    ledger.decryptImpl = () => new Promise((resolve) => { resolveDecrypt = resolve; });

    let renderer = await mount();
    await waitFor(() => ledger.decryptCalls.length === 1, 'the pending decrypt');
    await waitFor(
      () => published.some((value) => value?.yourFiles.count === 1),
      'the pre-switch breakdown',
    );

    advanceAccountEpoch();
    await act(async () => {
      resolveDecrypt([{ name: 'Backups', mimeType: null }]);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(ledger.saves).toHaveLength(0);
    expect(published.filter(Boolean).every((value) => value.backups.total.count === 0)).toBe(true);
    await unmount(renderer);

    // The old account's result must not have entered the module-level cache.
    ledger.decryptImpl = async () => [{ name: 'Backups for current account', mimeType: null }];
    renderer = await mount();
    await waitFor(() => ledger.decryptCalls.length === 2, 'a fresh current-account decrypt');
    await unmount(renderer);
  });
});
