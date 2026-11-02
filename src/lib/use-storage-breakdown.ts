/**
 * Feeds the Storage page breakdown: the file index plus decrypted names, all
 * on this phone. Recomputed when the index or the names change, never per render.
 */
import { useEffect, useMemo, useState } from 'react';
import { loadFileIndex } from './file-index-loader';
import { loadNameCache, scheduleSaveNameCache, type CachedName, type NameCache } from './name-cache';
import { useCrypto } from './crypto-context';
import { getProtectedBackupsRootId } from './protected-folders';
import type { FileEntry } from './api';
import { accountEpoch, isCurrentAccountEpoch, onAccountEpochAdvance } from './account-epoch';
import { computeStorageBreakdown, findBackupsRoot, type BreakdownRow, type StorageBreakdown } from './storage-breakdown';

const DECRYPT_BATCH = 100;

interface Known { name: string; mime: string | null }

// The persisted cache deliberately keeps only its newest 20,000 entries. Keep
// the complete, versioned set learned by Storage for this signed-in session so
// a large vault does not immediately re-decrypt the entries omitted on disk.
let sessionNameCache: NameCache = {};
onAccountEpochAdvance(() => {
  sessionNameCache = {};
});

const rowVersion = (file: FileEntry) => file.version_number ?? 0;

function toRows(files: FileEntry[], names: Record<string, Known>): BreakdownRow[] {
  return files.map((f) => ({
    id: f.id,
    parentId: f.parent_id ?? null,
    isFolder: f.is_folder,
    size: f.size_bytes,
    name: names[f.id]?.name ?? null,
    mime: names[f.id]?.mime ?? f.mime_type ?? null,
    isMedia: f.is_media,
    uploading: f.is_uploading,
  }));
}

export function useStorageBreakdown(totalBytes: number | null): StorageBreakdown | null {
  const { isUnlocked, decryptNames } = useCrypto();
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [names, setNames] = useState<Record<string, Known>>({});

  useEffect(() => {
    let cancelled = false;
    // Capture before the first await. Neither decrypted plaintext nor an old
    // account's index may be handed to a later account.
    const epoch = accountEpoch();
    void (async () => {
      const [{ files: loaded }, cache] = await Promise.all([
        loadFileIndex().catch(() => ({ files: null as FileEntry[] | null })),
        loadNameCache().catch(() => ({} as NameCache)),
      ]);
      if (cancelled || !loaded || !isCurrentAccountEpoch(epoch)) return;

      const known: Record<string, Known> = {};
      for (const file of loaded) {
        const version = rowVersion(file);
        const inSession = sessionNameCache[file.id];
        const onDisk = cache[file.id];
        const hit = inSession?.version === version
          ? inSession
          : onDisk?.version === version
            ? onDisk
            : null;
        if (hit) {
          known[file.id] = { name: hit.name, mime: hit.mime };
          sessionNameCache[file.id] = hit;
        } else if (inSession) {
          // A rename/version replacement invalidates the in-memory copy too.
          delete sessionNameCache[file.id];
        }
      }

      setFiles(loaded);
      setNames(known);
      if (!isUnlocked) return;

      // Folders (category names) and non-media files (documents vs other) need
      // a name; media is already known from the index.
      const misses = loaded.filter((f) => !known[f.id] && (f.is_folder || f.is_media !== true));
      if (misses.length === 0) return;
      const learned: Record<string, Known> = { ...known };
      for (let i = 0; i < misses.length; i += DECRYPT_BATCH) {
        if (cancelled || !isCurrentAccountEpoch(epoch)) return;
        const batch = misses.slice(i, i + DECRYPT_BATCH);
        let results: Awaited<ReturnType<typeof decryptNames>>;
        try {
          results = await decryptNames(batch.map((f) => ({ fileId: f.id, nameEncrypted: f.name_encrypted ?? '' })));
        } catch {
          if (cancelled || !isCurrentAccountEpoch(epoch)) return;
          break;
        }
        if (cancelled || !isCurrentAccountEpoch(epoch)) return;

        const learnedThisBatch: NameCache = {};
        results.forEach((r, idx) => {
          const file = batch[idx];
          if (!file || !r || r.error || !r.name) return;
          const cached: CachedName = {
            name: r.name,
            mime: r.mimeType ?? null,
            version: rowVersion(file),
          };
          learned[file.id] = { name: cached.name, mime: cached.mime };
          learnedThisBatch[file.id] = cached;
        });

        if (Object.keys(learnedThisBatch).length > 0) {
          // Merge rather than replace: Strict Mode or another mounted Storage
          // view may finish a different batch between our awaits.
          sessionNameCache = { ...sessionNameCache, ...learnedThisBatch };
          // Pass an immutable full snapshot. name-cache applies its disk cap;
          // this module intentionally retains the uncapped session copy.
          scheduleSaveNameCache({ ...sessionNameCache }, epoch);
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
        if (cancelled || !isCurrentAccountEpoch(epoch)) return;
      }
      if (!cancelled && isCurrentAccountEpoch(epoch)) setNames(learned);
    })();
    return () => { cancelled = true; };
  }, [isUnlocked, decryptNames]);

  return useMemo(() => {
    if (!files) return null;
    const rows = toRows(files, names);
    return computeStorageBreakdown({
      rows,
      backupsRootId: findBackupsRoot(rows, getProtectedBackupsRootId()),
      totalBytes,
    });
  }, [files, names, totalBytes]);
}
