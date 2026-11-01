// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Behaviour tests of the shared "Duplicate" helper with every effect mocked:
// name picking, success, cancel / quota cleanup, the large-file confirm,
// folders refused.
import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  DUPLICATE_CONFIRM_BYTES,
  DuplicateCancelledError,
  DuplicateRefusedError,
  duplicateFile,
  duplicateTempExtension,
  needsLargeFileConfirm,
  pickCopyName,
} from './duplicate-file'

describe('pickCopyName', () => {
  test('adds (copy) before the extension', () => {
    expect(pickCopyName('Report.pdf', [])).toBe('Report (copy).pdf')
  })
  test('no extension: appended at the end', () => {
    expect(pickCopyName('Notes', [])).toBe('Notes (copy)')
  })
  test('a leading dot is not an extension', () => {
    expect(pickCopyName('.env', [])).toBe('.env (copy)')
  })
  test('only the last extension is kept apart', () => {
    expect(pickCopyName('a.tar.gz', [])).toBe('a.tar (copy).gz')
  })
  test('(copy 2) when (copy) exists, then (copy 3)', () => {
    expect(pickCopyName('Report.pdf', ['Report (copy).pdf'])).toBe('Report (copy 2).pdf')
    expect(pickCopyName('Report.pdf', ['Report (copy).pdf', 'Report (copy 2).pdf'])).toBe('Report (copy 3).pdf')
  })
  test('the comparison ignores case', () => {
    expect(pickCopyName('Report.pdf', ['REPORT (COPY).PDF'])).toBe('Report (copy 2).pdf')
  })
})

describe('needsLargeFileConfirm', () => {
  test('threshold is above 500 MB, not at it', () => {
    expect(DUPLICATE_CONFIRM_BYTES).toBe(500 * 1024 * 1024)
    expect(needsLargeFileConfirm(DUPLICATE_CONFIRM_BYTES)).toBe(false)
    expect(needsLargeFileConfirm(DUPLICATE_CONFIRM_BYTES + 1)).toBe(true)
    expect(needsLargeFileConfirm(null)).toBe(false)
  })
})

describe('duplicate temp filename', () => {
  test('uses a private cache variant while preserving the real final extension', () => {
    expect(duplicateTempExtension('Clip.MP4')).toBe('duplicate.mp4')
    expect(duplicateTempExtension('Report.PDF')).toBe('duplicate.pdf')
    expect(duplicateTempExtension('README')).toBe('duplicate.bin')
  })
})

const src = { id: 'old', name: 'Report.pdf', mimeType: 'application/pdf', sizeBytes: 1000, chunkCount: 1, parentId: 'folder-1', isFolder: false }

function makeDeps(over = {}) {
  const order = []
  const deps = {
    order,
    isUnlocked: () => true,
    hasStorageCapacity: mock(async () => true),
    listFolderNames: mock(async () => { order.push('list'); return ['Report.pdf'] }),
    generateFileId: mock(async () => 'new-id'),
    withLease: async (_label, fn) => fn({ assertValid() {}, signal: new AbortController().signal }),
    download: mock(async (_s, o) => { order.push('download'); o.onProgress(1); return 'cache/tmp' }),
    releaseDownload: mock(async () => { order.push('release') }),
    upload: mock(async (a) => { order.push('upload'); a.onProgress(0.5); return { id: a.fileId, created_at: 'now' } }),
    abandonUpload: mock(async () => { order.push('abandon') }),
    makeThumbnails: mock(async () => { order.push('thumbs') }),
    confirmLarge: mock(async () => true),
    ...over,
  }
  return deps
}

describe('duplicateFile', () => {
  test('success: copy named, same folder, new id, temp deleted last', async () => {
    const deps = makeDeps()
    const progress = []
    const r = await duplicateFile(src, deps, { onProgress: (p) => progress.push(p) })
    expect(r.name).toBe('Report (copy).pdf')
    expect(r.entry.id).toBe('new-id')
    expect(deps.upload.mock.calls[0][0]).toMatchObject({ fileId: 'new-id', uri: 'cache/tmp', name: 'Report (copy).pdf', parentId: 'folder-1', mimeType: 'application/pdf' })
    expect(deps.order).toEqual(['list', 'download', 'upload', 'thumbs', 'release'])
    expect(deps.abandonUpload).not.toHaveBeenCalled()
    expect(progress[progress.length - 1]).toBe(1)
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1])).toBe(true)
  })

  test('folders are refused before any work', async () => {
    const deps = makeDeps()
    await expect(duplicateFile({ ...src, isFolder: true }, deps, {})).rejects.toBeInstanceOf(DuplicateRefusedError)
    expect(deps.download).not.toHaveBeenCalled()
    expect(deps.listFolderNames).not.toHaveBeenCalled()
  })

  test('large file: declined confirm does nothing', async () => {
    const deps = makeDeps({ confirmLarge: mock(async () => false) })
    await expect(duplicateFile({ ...src, sizeBytes: DUPLICATE_CONFIRM_BYTES + 1 }, deps, {})).rejects.toBeInstanceOf(DuplicateCancelledError)
    expect(deps.download).not.toHaveBeenCalled()
  })

  test('large file: accepted confirm proceeds; small file never asks', async () => {
    const big = makeDeps()
    await duplicateFile({ ...src, sizeBytes: DUPLICATE_CONFIRM_BYTES + 1 }, big, {})
    expect(big.confirmLarge).toHaveBeenCalledTimes(1)
    const small = makeDeps()
    await duplicateFile(src, small, {})
    expect(small.confirmLarge).not.toHaveBeenCalled()
  })

  test('known insufficient storage refuses before listing or downloading', async () => {
    const deps = makeDeps({ hasStorageCapacity: mock(async () => false) })
    await expect(duplicateFile(src, deps, {})).rejects.toBeInstanceOf(DuplicateRefusedError)
    expect(deps.listFolderNames).not.toHaveBeenCalled()
    expect(deps.download).not.toHaveBeenCalled()
  })

  test('cancel during download: temp released, nothing uploaded', async () => {
    const ac = new AbortController()
    const deps = makeDeps({
      download: mock(async () => { ac.abort(); throw new Error('aborted') }),
    })
    await expect(duplicateFile(src, deps, { signal: ac.signal })).rejects.toBeInstanceOf(DuplicateCancelledError)
    expect(deps.releaseDownload).toHaveBeenCalledTimes(1)
    expect(deps.upload).not.toHaveBeenCalled()
  })

  test('cancel during upload: upload session abandoned and temp released', async () => {
    const ac = new AbortController()
    const deps = makeDeps({
      upload: mock(async () => { ac.abort(); throw new Error('aborted') }),
    })
    await expect(duplicateFile(src, deps, { signal: ac.signal })).rejects.toBeInstanceOf(DuplicateCancelledError)
    expect(deps.abandonUpload).toHaveBeenCalledWith('new-id')
    expect(deps.releaseDownload).toHaveBeenCalledTimes(1)
    expect(deps.makeThumbnails).not.toHaveBeenCalled()
  })

  test('quota refusal: same cleanup, original error rethrown', async () => {
    const quota = Object.assign(new Error('quota'), { code: 'quota_exceeded' })
    const deps = makeDeps({ upload: mock(async () => { throw quota }) })
    await expect(duplicateFile(src, deps, {})).rejects.toBe(quota)
    expect(deps.abandonUpload).toHaveBeenCalledWith('new-id')
    expect(deps.releaseDownload).toHaveBeenCalledTimes(1)
  })

  test('an abandon failure does not mask the real error', async () => {
    const boom = new Error('boom')
    const deps = makeDeps({
      upload: mock(async () => { throw boom }),
      abandonUpload: mock(async () => { throw new Error('offline') }),
    })
    await expect(duplicateFile(src, deps, {})).rejects.toBe(boom)
    expect(deps.releaseDownload).toHaveBeenCalledTimes(1)
  })

  test('a thumbnail failure never fails the copy', async () => {
    const deps = makeDeps({ makeThumbnails: mock(async () => { throw new Error('x') }) })
    const r = await duplicateFile(src, deps, {})
    expect(r.entry.id).toBe('new-id')
    expect(deps.releaseDownload).toHaveBeenCalledTimes(1)
  })

  test('locked vault refuses', async () => {
    const deps = makeDeps({ isUnlocked: () => false })
    await expect(duplicateFile(src, deps, {})).rejects.toThrow(/unlock/i)
    expect(deps.download).not.toHaveBeenCalled()
  })
})

describe('guard: the temp file goes through the plaintext gate', () => {
  const wiring = readFileSync(new URL('./duplicate-file-deps.ts', import.meta.url), 'utf8')
  test('the real deps lease the gate and use the gated, registered decrypt path', () => {
    expect(wiring).toContain('withPlaintextLease')
    expect(wiring).toContain('decryptToTempFile')
    expect(wiring).toContain('releasePreviewCopy')
    expect(wiring).toContain('getStorageUsage')
    expect(wiring).toContain('streamVideo: false')
  })
  test('no direct writes into the caches directory', () => {
    expect(wiring).not.toMatch(/cacheDirectory/)
    expect(wiring).not.toMatch(/writeAsStringAsync|copyAsync/)
    expect(wiring).not.toContain("? 'copy'")
  })
})
