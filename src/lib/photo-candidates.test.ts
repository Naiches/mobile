// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1687c — freshly uploaded images must appear in the Photos tab (grid
// AND pager derive from the same candidate list).
//
// RED-first evidence (mutation protocol): with the pre-fix row decision
// (`!entry.is_uploading` kept in photoCandidatesFromIndex) the "upload row
// still in flight" cases below FAIL; see task 1687 Notes for the pasted
// failure and the revert-to-green run.
import { describe, expect, test } from 'bun:test';
import {
  isMediaFile,
  isVisibleMediaFile,
  previewMimeType,
  mediaMimeType,
  photoCandidatesFromIndex,
} from './photo-candidates';

const ENCRYPTED_NAME = '{"cipher_suite":"A256GCM","nonce":[1,2,3],"ciphertext":[9]}';

/** A fresh manual photo upload exactly as /files/index serves it mid-upload:
 *  mime encrypted (no plaintext column), thumbnail PUT not landed yet,
 *  is_media set by the client's upload-time classification. */
function freshUploadingImageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'fresh-1',
    name_encrypted: ENCRYPTED_NAME,
    mime_type: null,
    size_bytes: 12345,
    is_folder: false,
    is_uploading: true,
    chunk_count: 1,
    created_at: '2026-10-02T10:00:00Z',
    updated_at: '2026-10-02T10:00:00Z',
    has_thumbnail: false,
    is_media: true,
    ...overrides,
  };
}

describe('photoCandidatesFromIndex (task 1687c)', () => {
  test('a fresh upload row appears the moment it exists — even while is_uploading', () => {
    const out = photoCandidatesFromIndex([freshUploadingImageRow()]);
    expect(out.map((e) => e.id)).toEqual(['fresh-1']);
  });

  test('the same row is still a candidate once the upload completes', () => {
    const out = photoCandidatesFromIndex([freshUploadingImageRow({ is_uploading: false })]);
    expect(out.map((e) => e.id)).toEqual(['fresh-1']);
  });

  test('a fresh upload without a thumbnail yet but with a legacy mime still appears', () => {
    const row = freshUploadingImageRow({ is_uploading: false, is_media: undefined, mime_type: 'image/jpeg' });
    expect(photoCandidatesFromIndex([row]).map((e) => e.id)).toEqual(['fresh-1']);
  });

  test('a row classified only by its encrypted thumbnail still appears', () => {
    const row = freshUploadingImageRow({ is_uploading: false, is_media: undefined });
    const withThumb = { ...row, has_thumbnail: true };
    expect(photoCandidatesFromIndex([withThumb]).map((e) => e.id)).toEqual(['fresh-1']);
  });

  test('non-media rows and folders never enter the Photos tab', () => {
    const doc = freshUploadingImageRow({ id: 'doc-1', is_media: false, is_uploading: false });
    const folder = freshUploadingImageRow({ id: 'folder-1', is_folder: true, is_uploading: false });
    const out = photoCandidatesFromIndex([doc, folder]);
    expect(out).toEqual([]);
  });

  test('an uploading row WITHOUT any media signal stays out (no false positives)', () => {
    // A mid-upload row that never declared is_media (older server/paths) and
    // has no mime/thumbnail has no evidence it is a photo — it must not
    // appear, or the Photos tab would fill with documents.
    const opaque = freshUploadingImageRow({ is_media: undefined });
    expect(photoCandidatesFromIndex([opaque])).toEqual([]);
  });
});

describe('mediaMimeType (1687c regression detail)', () => {
  test('is_media alone says "media", not "image": the kind stays unknown until the name is decrypted', () => {
    // A video row as the index serves it: encrypted name, is_media set, no
    // thumbnail yet. Guessing image/jpeg here made the pager open it as a photo.
    const video = freshUploadingImageRow({ id: 'video-1' });
    expect(mediaMimeType(video)).toBe(null);
    expect(isMediaFile(video)).toBe(true);
    expect(isMediaFile(freshUploadingImageRow({ is_media: false }))).toBe(false);
  });

  test('a known category or file name still decides the kind', () => {
    expect(mediaMimeType(freshUploadingImageRow({ category: 'video' }))).toBe('video/mp4');
    expect(mediaMimeType(freshUploadingImageRow({ category: 'photo' }))).toBe('image/jpeg');
  });

  test('previewMimeType: the decrypted mime wins; an unknown kind stays undefined, never image/jpeg', () => {
    const video = freshUploadingImageRow({ id: 'video-1' });
    expect(previewMimeType(video, { 'video-1': 'video/quicktime' })).toBe('video/quicktime');
    expect(previewMimeType(video, {})).toBeUndefined();
    expect(previewMimeType({ ...video, mime_type: 'image/heic' }, {})).toBe('image/heic');
  });

  test('name_encrypted is never mistaken for a filename', () => {
    // filenameCandidates filters JSON blobs; only the is_media fallback can
    // classify the row.
    expect(mediaMimeType({ ...freshUploadingImageRow(), is_media: undefined })).toBe(null);
  });
});

describe('isVisibleMediaFile (render-time gate over the candidate list)', () => {
  test('a decrypted image mime admits the row; a decrypted document mime rejects it', () => {
    const row = freshUploadingImageRow({ is_uploading: false });
    expect(isVisibleMediaFile(row, { 'fresh-1': 'image/jpeg' })).toBe(true);
    expect(isVisibleMediaFile(row, { 'fresh-1': 'application/pdf' })).toBe(false);
  });

  test('without decrypted mime it falls back to the raw-row signals', () => {
    expect(isVisibleMediaFile(freshUploadingImageRow({ is_uploading: false }), {})).toBe(true);
    expect(isVisibleMediaFile(freshUploadingImageRow({ is_uploading: false, is_media: undefined }), {})).toBe(false);
  });
});