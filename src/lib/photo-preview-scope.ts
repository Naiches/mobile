import { isEncryptedThumbnailCandidate, mediaMimeType, type PhotoCandidateFileEntry } from './photo-candidates';

export interface PreviewScopePartition<T> {
  /** Candidate rows in paint order, with whatever MIME is already known. */
  files: { entry: T; mime: string | null }[];
  /** Ambiguous encrypted rows worth opening because their original is on this phone. */
  localEncrypted: T[];
}

/** Remaining time for one batch, capped by one deadline for the whole scope load. */
export function remainingPreviewScopeBudget(
  startedAtMs: number,
  nowMs: number,
  totalTimeoutMs: number,
  perBatchTimeoutMs: number,
): number {
  return Math.max(0, Math.min(perBatchTimeoutMs, totalTimeoutMs - (nowMs - startedAtMs)));
}

/** Apply all collected metadata in one pass; untouched rows keep their identity. */
export function mergePreviewScopeMimes<T extends { id: string; mime_type?: string | null }>(
  files: readonly T[],
  mimes: ReadonlyMap<string, string>,
): T[] {
  return files.map((file) => {
    const mime = mimes.get(file.id);
    return mime && mime !== file.mime_type ? { ...file, mime_type: mime } : file;
  });
}

/**
 * Build the preview-settings scope without assuming production exposes a
 * plaintext MIME. Known rows paint first; only ambiguous local rows need a
 * metadata decrypt before they can become actionable.
 */
export function partitionPreviewScope<T extends PhotoCandidateFileEntry>(
  entries: T[],
  localIds: ReadonlyMap<string, string>,
): PreviewScopePartition<T> {
  const candidates = entries
    .filter((entry) => !entry.is_folder && !entry.is_uploading)
    .filter((entry) => mediaMimeType(entry) !== null || entry.is_media === true || isEncryptedThumbnailCandidate(entry));

  const ranked = candidates
    .map((entry, order) => ({ entry, mime: mediaMimeType(entry), order }))
    .sort((a, b) => {
      const rank = (item: typeof a) => item.mime?.toLowerCase().startsWith('image/')
        ? 0
        : item.mime
          ? 1
          : localIds.has(item.entry.id)
            ? 2
            : 3;
      return rank(a) - rank(b) || a.order - b.order;
    });

  return {
    files: ranked.map(({ entry, mime }) => ({ entry, mime })),
    localEncrypted: ranked
      .filter(({ entry, mime }) => !mime && localIds.has(entry.id) && entry.name_encrypted.startsWith('{'))
      .map(({ entry }) => entry),
  };
}
