import type { FileEntry } from './api';

interface CompletedUploadPayload extends Partial<FileEntry> {
  status?: string;
  already_completed?: boolean;
}

interface KnownUploadFields {
  id: string;
  nameEncrypted: string;
  sizeBytes: number;
  chunkCount: number;
  parentId?: string | null;
  mimeType?: string | null;
  createdAt?: string;
  nowIso?: string;
}

/** Fill fields that older upload-complete responses omit from their acknowledgement. */
export function normalizeCompletedUpload(
  response: CompletedUploadPayload,
  known: KnownUploadFields,
): FileEntry {
  const now = known.nowIso ?? new Date().toISOString();
  return {
    ...response,
    id: response.id ?? known.id,
    // `known` reflects a successful post-complete name correction. Older
    // complete responses still carry the pre-correction ciphertext.
    name_encrypted: known.nameEncrypted,
    mime_type: response.mime_type ?? known.mimeType ?? null,
    size_bytes: response.size_bytes ?? known.sizeBytes,
    is_folder: false,
    is_uploading: false,
    chunk_count: response.chunk_count ?? known.chunkCount,
    created_at: response.created_at ?? known.createdAt ?? now,
    updated_at: response.updated_at ?? now,
    parent_id: response.parent_id === undefined ? (known.parentId ?? null) : response.parent_id,
  };
}

/** Replace the pending row exactly once, including a defensive server-id mismatch. */
export function reconcileCompletedUploadRows(
  entries: readonly FileEntry[],
  pendingId: string | null,
  completed: FileEntry,
  replacedExisting: boolean,
): FileEntry[] {
  const retained = pendingId && pendingId !== completed.id
    ? replacedExisting
      ? entries.map((entry) => entry.id === pendingId ? { ...entry, is_uploading: false } : entry)
      : entries.filter((entry) => entry.id !== pendingId)
    : entries;
  return [completed, ...retained.filter((entry) => entry.id !== completed.id)];
}
