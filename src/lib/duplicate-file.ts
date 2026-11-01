/**
 * "Duplicate" for a file, made on the phone. A file's key is derived from its
 * file id, so the server cannot copy stored chunks under a new id: the copy is
 * downloaded and decrypted, then encrypted as a NEW file (new id, new key,
 * new metadata) and uploaded into the same folder as "Name (copy).ext".
 *
 * Every effect is injected (see duplicate-file-deps.ts for the real ones) so
 * this flow is unit-tested with mocks. Order, and why:
 *   1. Folders are refused and a large file asks first, before any work.
 *   2. A FRESH listing of the folder picks the copy name (the on-screen list
 *      can lag a sibling made on another device).
 *   3. Under a plaintext-gate lease: download + decrypt to a temp file (0-50%),
 *      then the encrypted upload of that file under a new id (50-100%).
 *   4. On any failure or cancel after a new id exists: best-effort abandon of
 *      that upload session, so no half-made file is left behind.
 *   5. The temp file is released in a `finally`, whatever happened.
 */

export const DUPLICATE_CONFIRM_BYTES = 500 * 1024 * 1024

/** True when the file is big enough to ask before downloading + uploading it again. */
export function needsLargeFileConfirm(sizeBytes: number | null | undefined): boolean {
  return typeof sizeBytes === 'number' && sizeBytes > DUPLICATE_CONFIRM_BYTES
}

/**
 * "Name (copy).ext", or "Name (copy 2).ext", "(copy 3)", … when taken
 * (case-insensitive). A leading dot is not an extension.
 */
export function pickCopyName(name: string, existingNames: Iterable<string>): string {
  const taken = new Set<string>()
  for (const n of existingNames) taken.add(n.toLowerCase())
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = `${base} (copy)${ext}`
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
    candidate = `${base} (copy ${n})${ext}`
  }
  return candidate
}

/** A private preview-cache variant whose final suffix stays useful to native readers. */
export function duplicateTempExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  const raw = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : 'bin'
  const ext = raw.replace(/[^a-z0-9]/g, '') || 'bin'
  // `fileId.duplicate.mp4` cannot join/race Preview's `fileId.mp4`, while
  // AVFoundation and thumbnail generators still see the real final suffix.
  return `duplicate.${ext}`
}

export class DuplicateRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DuplicateRefusedError'
  }
}

/** The person cancelled (or declined the large-file confirm). Callers stay silent. */
export class DuplicateCancelledError extends Error {
  constructor() {
    super('Duplicate cancelled.')
    this.name = 'DuplicateCancelledError'
  }
}

export interface DuplicateSource {
  id: string
  name: string
  mimeType: string | null
  sizeBytes: number | null
  chunkCount?: number | null
  parentId: string | null
  isFolder: boolean
  /** A file-request upload is keyed by its request content key, not the vault key. */
  requestKey?: () => Promise<Uint8Array>
}

export interface DuplicatedEntry {
  id: string
  created_at?: string
}

interface LeaseLike {
  assertValid(): void
  signal: AbortSignal
}

export interface DuplicateDeps<E extends DuplicatedEntry> {
  isUnlocked: () => boolean
  /** Best-effort quota preflight. Unknown/unavailable usage should return true. */
  hasStorageCapacity: (sizeBytes: number) => Promise<boolean>
  /** Every decryptable name in the folder, from a FRESH listing. */
  listFolderNames: (parentId: string | null) => Promise<string[]>
  generateFileId: () => Promise<string>
  /** Runs `fn` holding a plaintext-gate lease (released however it ends). */
  withLease: <T>(label: string, fn: (lease: LeaseLike) => Promise<T>) => Promise<T>
  /** Download + decrypt to a temp file; resolves its uri. `onProgress` is 0..1. */
  download: (
    source: DuplicateSource,
    opts: { signal: AbortSignal; onProgress: (fraction: number) => void },
  ) => Promise<string>
  /** Delete the temp file (also after a failed or cancelled download). */
  releaseDownload: (source: DuplicateSource) => Promise<void>
  upload: (args: {
    fileId: string
    uri: string
    name: string
    parentId: string | null
    mimeType: string | null
    signal: AbortSignal
    onProgress: (fraction: number) => void
  }) => Promise<E>
  /** Clears a half-finished upload of `fileId` on the server. */
  abandonUpload: (fileId: string) => Promise<void>
  /** Thumbnails for the new file, generated like a normal upload's. Failures are swallowed. */
  makeThumbnails: (entry: E, uri: string, mimeType: string | null) => Promise<void>
  /** Asks the large-file question; true = continue. */
  confirmLarge: (sizeBytes: number) => Promise<boolean>
}

export interface DuplicateOptions {
  signal?: AbortSignal
  /** Overall progress 0..1, never decreasing. */
  onProgress?: (fraction: number) => void
}

export async function duplicateFile<E extends DuplicatedEntry>(
  source: DuplicateSource,
  deps: DuplicateDeps<E>,
  options: DuplicateOptions = {},
): Promise<{ entry: E; name: string }> {
  if (source.isFolder) throw new DuplicateRefusedError("Folders can't be duplicated yet.")
  if (!deps.isUnlocked()) throw new Error('The vault locked. Unlock it, then try again.')
  if (needsLargeFileConfirm(source.sizeBytes) && !(await deps.confirmLarge(source.sizeBytes as number))) {
    throw new DuplicateCancelledError()
  }

  const controller = new AbortController()
  const forward = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', forward, { once: true })
  const signal = controller.signal

  let last = 0
  const report = (fraction: number) => {
    last = Math.max(last, Math.min(1, fraction))
    options.onProgress?.(last)
  }
  const cancelled = () => signal.aborted || !!options.signal?.aborted
  const throwIfCancelled = () => {
    if (cancelled()) throw new DuplicateCancelledError()
  }

  try {
    throwIfCancelled()
    if (typeof source.sizeBytes === 'number' && source.sizeBytes > 0) {
      const hasCapacity = await deps.hasStorageCapacity(source.sizeBytes)
      throwIfCancelled()
      if (!hasCapacity) {
        throw new DuplicateRefusedError('There is not enough storage space to duplicate this file.')
      }
    }
    const siblings = await deps.listFolderNames(source.parentId)
    const name = pickCopyName(source.name, siblings)
    let fileId: string | null = null
    try {
      const entry = await deps.withLease('duplicate file', async (lease) => {
        lease.signal.addEventListener('abort', forward, { once: true })
        if (lease.signal.aborted) controller.abort()
        throwIfCancelled()
        const uri = await deps.download(source, { signal, onProgress: (f) => report(f * 0.5) })
        throwIfCancelled()
        lease.assertValid()
        fileId = await deps.generateFileId()
        const uploaded = await deps.upload({
          fileId,
          uri,
          name,
          parentId: source.parentId,
          mimeType: source.mimeType,
          signal,
          onProgress: (f) => report(0.5 + f * 0.5),
        })
        try {
          lease.assertValid()
          await deps.makeThumbnails(uploaded, uri, source.mimeType)
        } catch {
          // The copy exists; a missing thumbnail is repaired like any other.
        }
        return uploaded
      })
      report(1)
      return { entry, name }
    } catch (err) {
      if (fileId) {
        try {
          await deps.abandonUpload(fileId)
        } catch {
          // Best-effort: the server's stale-upload sweep is the backstop.
        }
      }
      if (cancelled()) throw new DuplicateCancelledError()
      throw err
    } finally {
      try {
        await deps.releaseDownload(source)
      } catch {
        // A leftover cache file is purged on sign-out and evicted by the OS.
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', forward)
  }
}
