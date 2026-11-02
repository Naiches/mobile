// @ts-nocheck -- Bun test harness, matching the isolated suite convention.
// A file this device just created (a Duplicate copy, any upload) is listed while its upload is still pending, and
// its name does not decrypt yet. The shared-key fallback then records a failure for it. That verdict must not
// outlive the moment the file proves it opens with the account's own key, or the row keeps reading
// "Can't open this file".
import { beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { clearSharedKeys, configureSharedKeys, createSharedKeyResolver, forgetSharedKeyOutcome, markOwnerUploadComplete, resolveSharedNames, retrySharedDecrypt, sharedKeyOutcome } from './shared-folder-keys';
import { accountEpoch, advanceAccountEpoch } from './account-epoch';
import { ingestTree } from './shared-folder-tree';
import { setExpectedUserId } from './expected-user';
import { createCustodyMemory } from './shared-folder-custody';

const store = new Map<string, string>();
const port = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => { store.set(k, v); } };
function ports(getFileOwnerWrap = async () => ({ ownerWrap: null, actedViaShareId: null })) {
  return {
    custody: createCustodyMemory(port, { exists: async () => false, write: async () => {} }),
    getSharedFolder: async () => { throw { status: 404 }; },
    listSharedFolderKeys: async () => ({ keys: [], next_cursor: null }),
    getFileOwnerWrap, listFolderLinks: async () => [],
    masterHandleId: () => 1, epoch: accountEpoch, now: () => 0,
    native: {
      isSharedKeysNativeReady: () => true, sharedFolderOpenOwnerKey: async () => 2,
      sharedFileKeysLoad: async () => ({ loaded: [], failed: [] }), sharedFileKeyIsLoaded: () => false,
      sharedFileKeyOpenOwnerWrap: async () => false, sharedFolderDecryptName: async () => null,
      sharedFolderRelease: async () => {}, sharedKeysClear: async () => {},
    },
  };
}
const mismatch = { name: null, error: 'Decryption failed' };
beforeEach(() => { clearSharedKeys(); setExpectedUserId('acct-a'); ingestTree([]); store.clear(); });

test('a_pending_row_whose_name_fails_records_a_failure_today', async () => {
  const r = createSharedKeyResolver(ports());
  await resolveSharedNames([{ fileId: 'new-1', nameEncrypted: 'x' }], async () => [mismatch], r);
  expect(sharedKeyOutcome('new-1')).toBe('no_shared_root');
});

test('a_later_successful_name_decrypt_clears_the_stale_failure', async () => {
  const r = createSharedKeyResolver(ports());
  await resolveSharedNames([{ fileId: 'new-2', nameEncrypted: 'x' }], async () => [mismatch], r);
  expect(sharedKeyOutcome('new-2')).toBe('no_shared_root');
  await resolveSharedNames([{ fileId: 'new-2', nameEncrypted: 'y' }], async () => [{ name: 'report (copy).pdf', error: null }], r);
  expect(sharedKeyOutcome('new-2')).toBeUndefined();
});

test('a_later_successful_metadata_decrypt_clears_the_stale_failure', async () => {
  const r = createSharedKeyResolver(ports());
  await resolveSharedNames([{ fileId: 'new-3', nameEncrypted: 'x' }], async () => [mismatch], r);
  await retrySharedDecrypt('new-3', async () => 'meta', r);
  expect(sharedKeyOutcome('new-3')).toBeUndefined();
});

test('forgetting_an_outcome_after_a_successful_decrypt_clears_it', async () => {
  const r = createSharedKeyResolver(ports());
  await resolveSharedNames([{ fileId: 'new-4', nameEncrypted: 'x' }], async () => [mismatch], r);
  forgetSharedKeyOutcome('new-4');
  expect(sharedKeyOutcome('new-4')).toBeUndefined();
});

test('a_lookup_in_flight_when_the_upload_completes_does_not_record_its_failure', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(res => { release = res; });
  const r = createSharedKeyResolver(ports(async () => { await gate; return { ownerWrap: null, actedViaShareId: null }; }));
  const pending = r.ensureLoaded(['new-5']);
  await Promise.resolve();
  markOwnerUploadComplete('new-5');
  release();
  expect((await pending).get('new-5')).toBe('no_shared_root');
  expect(sharedKeyOutcome('new-5')).toBeUndefined();
});

test('a_name_decrypt_started_before_upload_completion_cannot_record_its_later_fallback_failure', async () => {
  let release: () => void = () => {};
  let decryptStarted = false;
  const gate = new Promise<void>(res => { release = res; });
  const r = createSharedKeyResolver(ports());
  const pending = resolveSharedNames([{ fileId: 'new-6', nameEncrypted: 'pending-name' }], async () => {
    decryptStarted = true;
    await gate;
    return [mismatch];
  }, r);
  while (!decryptStarted) await Promise.resolve();
  markOwnerUploadComplete('new-6');
  release();
  await pending;
  expect(sharedKeyOutcome('new-6')).toBeUndefined();
});

test('an_older_failed_name_decrypt_cannot_overwrite_a_newer_success', async () => {
  let release: () => void = () => {};
  let decryptStarted = false;
  const gate = new Promise<void>(res => { release = res; });
  const r = createSharedKeyResolver(ports());
  const olderFailure = resolveSharedNames([{ fileId: 'new-6b', nameEncrypted: 'old' }], async () => {
    decryptStarted = true;
    await gate;
    return [mismatch];
  }, r);
  while (!decryptStarted) await Promise.resolve();
  await resolveSharedNames(
    [{ fileId: 'new-6b', nameEncrypted: 'current' }],
    async () => [{ name: 'report (copy).pdf', error: null }],
    r,
  );
  release();
  await olderFailure;
  expect(sharedKeyOutcome('new-6b')).toBeUndefined();
});

test('a_lookup_started_after_owner_upload_completion_cannot_restore_a_failure', async () => {
  const r = createSharedKeyResolver(ports());
  markOwnerUploadComplete('new-7');
  expect((await r.ensureLoaded(['new-7'])).get('new-7')).toBe('no_shared_root');
  expect(sharedKeyOutcome('new-7')).toBeUndefined();
});

test('a_successful_metadata_decrypt_clears_a_failure_after_the_native_key_becomes_loaded', async () => {
  let nativeLoaded = false;
  const p = ports();
  p.native.sharedFileKeyIsLoaded = () => nativeLoaded;
  const r = configureSharedKeys(p.native, p, () => 1);
  await resolveSharedNames([{ fileId: 'new-8', nameEncrypted: 'x' }], async () => [mismatch], r);
  expect(sharedKeyOutcome('new-8')).toBe('no_shared_root');
  nativeLoaded = true;
  await retrySharedDecrypt('new-8', async () => 'metadata', r);
  expect(sharedKeyOutcome('new-8')).toBeUndefined();
});

test('owner-upload proof is scoped to one account epoch', async () => {
  markOwnerUploadComplete('same-id');
  const first = createSharedKeyResolver(ports());
  await first.ensureLoaded(['same-id']);
  expect(sharedKeyOutcome('same-id')).toBeUndefined();

  advanceAccountEpoch();
  setExpectedUserId('acct-b');
  ingestTree([]);
  const second = createSharedKeyResolver(ports());
  await second.ensureLoaded(['same-id']);
  expect(sharedKeyOutcome('same-id')).toBe('no_shared_root');
});

test('a_genuine_shared_failure_on_a_file_that_never_decrypts_is_kept', async () => {
  const r = createSharedKeyResolver(ports());
  await resolveSharedNames([{ fileId: 'guest', nameEncrypted: 'x' }], async () => [mismatch], r);
  await resolveSharedNames([{ fileId: 'guest', nameEncrypted: 'x' }], async () => [mismatch], r);
  expect(sharedKeyOutcome('guest')).toBe('no_shared_root');
});

test('every_completed_owner_upload_marks_its_shared_key_outcome_complete', () => {
  const src = readFileSync(new URL('./encrypted-upload.ts', import.meta.url), 'utf8');
  expect(src.match(/markOwnerUploadComplete\(fileId\)/g)?.length).toBe(2);
});

test('pending upload rows describe upload state before any temporary shared-key verdict', () => {
  const src = readFileSync(new URL('../screens/FilesScreen.tsx', import.meta.url), 'utf8');
  const row = src.slice(src.indexOf('const FileRowItem'), src.indexOf('const FileGridItem'));
  expect(row).toContain('if (isPendingUpload) return');
  expect(row.indexOf('if (isPendingUpload) return')).toBeLessThan(row.indexOf('sharedOutcomeMessage'));
  const gridMeta = src.slice(src.indexOf('const metaText ='), src.indexOf('\n\n  return (', src.indexOf('const metaText =')));
  expect(gridMeta).toMatch(/^const metaText = isPendingUpload/);
});
