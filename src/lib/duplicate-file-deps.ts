/**
 * The real effects behind duplicate-file.ts. The decrypted copy is written by
 * `decryptToTempFile` (the native streaming download + decrypt, chunked, into
 * the registered, sign-out-purged `preview/` plaintext location) while this
 * module holds a plaintext-gate lease; nothing here writes a plaintext file
 * itself. The copy is then uploaded by `encryptedUpload` (native streaming
 * encrypt + chunked PUT) exactly like "Upload file".
 */
import { decryptMetadata as decryptMetadataWithKey } from '../../modules/beebeeb-crypto'
import { abandonFileUpload, getStorageUsage, listAllFiles } from './api'
import type { FileEntry } from './api'
import { decryptFolderNames } from './create-new-document'
import {
  DuplicateCancelledError,
  duplicateTempExtension,
  duplicateFile,
  type DuplicateDeps,
  type DuplicateOptions,
  type DuplicateSource,
} from './duplicate-file'
import { encryptedMetadataPayloadToBytes } from './encrypted-metadata'
import { encryptedUpload, generateFileId } from './encrypted-upload'
import { isRequestUpload } from './file-request-crypto'
import { decryptToTempFile, releasePreviewCopy } from './native-decrypt'
import { withPlaintextLease } from './plaintext-gate'
import { generateAndUploadThumbnail } from './thumbnail'
import { thumbnailUploadQueue } from './upload-queue'

/** The slice of useCrypto() this needs. */
export interface DuplicateCrypto {
  isUnlocked: boolean
  getFileKeyBytes: (fileId: string) => Promise<Uint8Array>
  getMasterKeyHandleId: () => number
  getRequestContentKey: (file: FileEntry) => Promise<Uint8Array>
  encryptChunk: Parameters<typeof encryptedUpload>[0]['encryptChunkFn']
  encryptMetadata: Parameters<typeof encryptedUpload>[0]['encryptMetadataFn']
  decryptNames: (
    items: { fileId: string; nameEncrypted: string }[],
  ) => Promise<{ name?: string | null; error?: unknown }[]>
}

export function createDuplicateDeps(
  crypto: DuplicateCrypto,
  confirmLarge: (sizeBytes: number) => Promise<boolean>,
): DuplicateDeps<FileEntry> {
  return {
    isUnlocked: () => crypto.isUnlocked,
    hasStorageCapacity: async (sizeBytes) => {
      try {
        const usage = await getStorageUsage()
        // A non-positive limit is the API's no-fixed-cap sentinel.
        return usage.plan_limit_bytes <= 0 || usage.used_bytes + sizeBytes <= usage.plan_limit_bytes
      } catch {
        // The upload remains the authoritative quota check when usage is unavailable.
        return true
      }
    },
    listFolderNames: async (parentId) => {
      const siblings = await listAllFiles(parentId ?? undefined)
      return decryptFolderNames(siblings, {
        isRequestUpload,
        decryptNormalNames: async (normal) => {
          const results = await crypto.decryptNames(
            normal.map((f) => ({ fileId: f.id, nameEncrypted: f.name_encrypted ?? '' })),
          )
          return normal.map((_, i) => {
            const r = results[i]
            return r && !r.error && r.name ? r.name : null
          })
        },
        decryptRequestUploadName: async (f) => {
          const payload = encryptedMetadataPayloadToBytes(f.name_encrypted ?? '')
          if (!payload) throw new Error('unreadable metadata')
          const plaintext = await decryptMetadataWithKey(
            await crypto.getRequestContentKey(f),
            payload.nonce,
            payload.ciphertext,
          )
          const name = (JSON.parse(plaintext) as { name?: unknown }).name
          if (typeof name !== 'string' || !name.trim()) throw new Error('unreadable metadata')
          return name.trim()
        },
        cachedName: () => undefined,
      })
    },
    generateFileId,
    withLease: (label, fn) => withPlaintextLease(label, fn),
    download: (source, { signal, onProgress }) => {
      const requestKey = source.requestKey
      return decryptToTempFile(
        source.id,
        requestKey ?? (() => crypto.getFileKeyBytes(source.id)),
        duplicateTempExtension(source.name),
        source.sizeBytes,
        source.chunkCount,
        requestKey ? null : crypto.getMasterKeyHandleId(),
        {
          signal,
          // A duplicate needs a completed local file, but keeps the real
          // extension so AVFoundation and thumbnailing can identify videos.
          streamVideo: false,
          useProvidedFileKey: !!requestKey,
          onProgress: (event) => {
            const total = event.bytesTotal ?? source.sizeBytes ?? 0
            const done = event.bytesDownloaded ?? 0
            if (total > 0) onProgress(Math.min(1, done / total))
          },
        },
      )
    },
    releaseDownload: async (source) => {
      await releasePreviewCopy(source.id, duplicateTempExtension(source.name))
    },
    upload: ({ fileId, uri, name, parentId, mimeType, signal, onProgress }) =>
      encryptedUpload({
        fileId,
        uri,
        name,
        parentId: parentId ?? undefined,
        mimeType: mimeType ?? undefined,
        encryptChunkFn: crypto.encryptChunk,
        encryptMetadataFn: crypto.encryptMetadata,
        masterKeyHandleId: crypto.getMasterKeyHandleId(),
        signal,
        onProgress: (p) => {
          if (p.bytesTotal > 0) onProgress(Math.min(1, p.bytesUploaded / p.bytesTotal))
        },
      }),
    abandonUpload: abandonFileUpload,
    makeThumbnails: async (entry, uri, mimeType) => {
      await Promise.allSettled(
        (['medium', 'small', 'large'] as const).map((variant) =>
          thumbnailUploadQueue.run(() =>
            generateAndUploadThumbnail(entry.id, uri, mimeType, crypto.getFileKeyBytes, variant),
          ),
        ),
      )
    },
    confirmLarge,
  }
}

export function runDuplicate(
  source: DuplicateSource,
  crypto: DuplicateCrypto,
  confirmLarge: (sizeBytes: number) => Promise<boolean>,
  options: DuplicateOptions,
) {
  return duplicateFile(source, createDuplicateDeps(crypto, confirmLarge), options)
}

export { DuplicateCancelledError }
