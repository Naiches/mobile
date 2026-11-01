import type { UploadProgress } from './api';

type Trace = (name: string, fields: Record<string, unknown>) => unknown;

let nextManualUploadTraceId = 0;

/** Timestamp the user-visible manual-upload pipeline without logging filenames. */
export function createManualUploadTrace(trace: Trace, now: () => number = Date.now) {
  const startedAt = now();
  const traceId = `manual-upload-${startedAt}-${++nextManualUploadTraceId}`;
  const seenTransitions = new Set<string>();
  let lastTracedChunk = 0;

  const mark = (phase: string, fields: Record<string, unknown> = {}) => {
    trace('upload.manual.phase', {
      traceId,
      phase,
      elapsedMs: Math.max(0, Math.round(now() - startedAt)),
      ...fields,
    });
  };

  return {
    mark,
    progress(progress: UploadProgress) {
      if (progress.phase === 'preparing') {
        if (seenTransitions.has('init_done')) return;
        seenTransitions.add('init_done');
        mark('init_done', {
          protocol: progress.protocol,
          chunksTotal: progress.chunksTotal,
          bytesTotal: progress.bytesTotal,
        });
        return;
      }
      if (progress.phase === 'uploading') {
        if (progress.chunksUploaded <= lastTracedChunk) return;
        lastTracedChunk = progress.chunksUploaded;
        mark('chunk_done', {
          chunk: progress.chunksUploaded,
          chunksTotal: progress.chunksTotal,
          bytesUploaded: progress.bytesUploaded,
        });
        return;
      }
      if (seenTransitions.has('complete_start')) return;
      seenTransitions.add('complete_start');
      mark('complete_start', { chunksTotal: progress.chunksTotal });
    },
  };
}
