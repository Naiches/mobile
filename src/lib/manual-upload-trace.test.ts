// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createManualUploadTrace } from './manual-upload-trace';

test('manual upload phases carry elapsed timestamps without duplicate transition marks', () => {
  let now = 1_000;
  const events: Array<Record<string, unknown>> = [];
  const phases = createManualUploadTrace(
    (_name, fields) => events.push(fields),
    () => now,
  );

  phases.mark('picker_return', { sizeBytes: 10_000 });
  now = 1_050;
  phases.mark('row_visible');
  now = 1_100;
  phases.mark('encrypted_upload_start');
  now = 1_250;
  phases.progress({ phase: 'preparing', chunksTotal: 1, chunksUploaded: 0, bytesTotal: 10_028, bytesUploaded: 0 });
  phases.progress({ phase: 'preparing', chunksTotal: 1, chunksUploaded: 0, bytesTotal: 10_028, bytesUploaded: 0 });
  now = 1_500;
  phases.progress({ phase: 'uploading', chunksTotal: 1, chunksUploaded: 1, bytesTotal: 10_028, bytesUploaded: 10_028 });
  now = 1_550;
  phases.progress({ phase: 'finalizing', chunksTotal: 1, chunksUploaded: 1, bytesTotal: 10_028, bytesUploaded: 10_028 });
  now = 1_700;
  phases.mark('complete_done');
  phases.mark('post_upload_scheduled');

  expect(events.map((event) => event.phase)).toEqual([
    'picker_return',
    'row_visible',
    'encrypted_upload_start',
    'init_done',
    'chunk_done',
    'complete_start',
    'complete_done',
    'post_upload_scheduled',
  ]);
  expect(events.map((event) => event.elapsedMs)).toEqual([0, 50, 100, 250, 500, 550, 700, 700]);
  expect(new Set(events.map((event) => event.traceId)).size).toBe(1);
  expect(events[0]?.traceId).toEqual(expect.stringContaining('manual-upload-'));
});

test('the Drive upload path records every phase and shows progress before name hydration', () => {
  const source = readFileSync(new URL('../screens/FilesScreen.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const pickAndUploadFile = useCallback(');
  const end = source.indexOf('const pickAndUploadPhotos = useCallback(', start);
  const body = source.slice(start, end);

  expect(body).toContain("uploadTrace.mark('picker_return'");
  expect(body).toContain("uploadTrace.mark('row_visible'");
  expect(body).toContain("uploadTrace.mark('name_hydration_wait_start'");
  expect(body).toContain("uploadTrace.mark('name_hydration_wait_done'");
  expect(body).toContain('uploadTrace.progress(progress)');
  expect(body).toContain("uploadTrace.mark('encrypted_upload_start'");
  expect(body).toContain("uploadTrace.mark('complete_done'");
  expect(body).toContain("uploadTrace.mark('shared_key_outcome_done'");
  expect(body).toContain("uploadTrace.mark('file_index_revalidate_done'");
  expect(body).toContain("uploadTrace.mark('post_upload_scheduled'");
  expect(body).toContain("uploadTrace.mark('file_provider_done'");
  expect(body).toContain("uploadTrace.mark('refresh_done'");
  expect(body).toContain("uploadTrace.mark('thumbnails_done'");
  expect(body).toContain('fetchFiles(currentFolder.id, true, { silent: true })');
  expect(body.indexOf("uploadTrace.mark('row_visible'")).toBeLessThan(body.indexOf('await waitForFolderNames()'));
});

test('a queued upload paints its pending row immediately without replacing the active upload card', () => {
  const source = readFileSync(new URL('../screens/FilesScreen.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const pickAndUploadFile = useCallback(');
  const end = source.indexOf('const pickAndUploadPhotos = useCallback(', start);
  const body = source.slice(start, end);
  const queuedBranch = body.slice(body.indexOf('if (queued)'), body.indexOf('// ── Conflict check'));

  expect(queuedBranch).toContain('showPendingRow(uploadFileId, uploadFileName, false)');
});
