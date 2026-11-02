/** Pure math used by the Photo previews settings screen. */

import type { PreviewFormat, PreviewPx } from './photo-preview-settings';

export interface KnownPreviewSize {
  preview_format?: string | null;
  preview_px?: number | null;
  preview_bytes?: number | null;
}

export interface ImmediatePreviewEstimate {
  avgBytes: number;
  sampled: number;
  basis: 'known-previews' | 'typical';
}

// Conservative typical encoded sizes from the variants the app offers. These
// make the setting responsive before a PhotoKit/iCloud sample has finished.
const TYPICAL_BYTES: Record<PreviewFormat, Record<PreviewPx, number>> = {
  heic: { 1280: 220_000, 1920: 420_000, 2560: 700_000, 3840: 1_250_000 },
  jpeg: { 1280: 420_000, 1920: 760_000, 2560: 1_250_000, 3840: 2_200_000 },
};

/** Immediate local estimate, refined by matching sizes already present in the index. */
export function immediatePreviewEstimate(
  format: PreviewFormat,
  px: PreviewPx,
  known: KnownPreviewSize[],
): ImmediatePreviewEstimate {
  const sizes = known
    .filter((item) => item.preview_format === format && item.preview_px === px)
    .map((item) => item.preview_bytes)
    .filter((bytes): bytes is number => typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0);
  if (sizes.length > 0) {
    return {
      avgBytes: Math.round(sizes.reduce((sum, bytes) => sum + bytes, 0) / sizes.length),
      sampled: sizes.length,
      basis: 'known-previews',
    };
  }
  return { avgBytes: TYPICAL_BYTES[format][px], sampled: 0, basis: 'typical' };
}

/** Up to n distinct ids drawn at random (partial Fisher-Yates); the input is not modified. */
export function pickSampleIds(allLocalIds: string[], n = 10, rng: () => number = Math.random): string[] {
  const pool = Array.from(new Set(allLocalIds));
  const take = Math.max(0, Math.min(Math.floor(n), pool.length));
  for (let i = 0; i < take; i++) {
    const j = i + Math.min(pool.length - i - 1, Math.floor(rng() * (pool.length - i)));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

/**
 * Projected size of all previews on this phone and how many fit in the local limit.
 * An unusable average (0, NaN) estimates 0 bytes and everything fits.
 */
export function estimateTotals(
  avgBytes: number,
  photoCount: number,
  cacheLimitBytes: number,
): { totalBytes: number; fitsAll: boolean; fitCount: number } {
  const count = Math.max(0, Math.floor(photoCount));
  const avg = Number.isFinite(avgBytes) && avgBytes > 0 ? avgBytes : 0;
  const totalBytes = Math.round(avg * count);
  const limit = Math.max(0, cacheLimitBytes);
  if (totalBytes <= limit) return { totalBytes, fitsAll: true, fitCount: count };
  return { totalBytes, fitsAll: false, fitCount: Math.min(count, Math.floor(limit / avg)) };
}

/**
 * Size estimate for one format/size, kept per setting key so a result that
 * lands after the user changed the setting (or after the photo list was
 * re-read) is stored under its own key and never stalls the one on screen.
 */
export type EstimateEntry =
  | { status: 'loading' }
  | { status: 'done'; avgBytes: number; sampled: number }
  | { status: 'failed' };

/** Native result -> entry. Nothing measured (every sample skipped) is a failure, not a 0 B estimate. */
export function estimateEntryFromResult(r: { averageBytes: number; sampled: number }): EstimateEntry {
  return r.sampled > 0 && Number.isFinite(r.averageBytes) && r.averageBytes > 0
    ? { status: 'done', avgBytes: r.averageBytes, sampled: r.sampled }
    : { status: 'failed' };
}

/**
 * Start a measurement for this key now? Not while one is already running for it
 * (a re-render reuses it) and not once it is done. A failed one is retried the
 * next time the screen asks (after Apply, Rebuild, Off or a new photo list).
 */
export function shouldStartEstimate(entry: EstimateEntry | undefined, inFlight: boolean): boolean {
  if (inFlight) return false;
  return entry?.status !== 'done';
}

export type EstimateView =
  | { kind: 'no-photos' }
  | { kind: 'measuring' }
  | { kind: 'ready'; avgBytes: number; sampled: number }
  | { kind: 'unavailable' };

/** What the "On this iPhone" card shows. Exactly one state: never a spinner next to "no estimate". */
export function estimateView(entry: EstimateEntry | undefined, hasPhotos: boolean): EstimateView {
  if (!hasPhotos) return { kind: 'no-photos' };
  if (!entry || entry.status === 'loading') return { kind: 'measuring' };
  if (entry.status === 'done') return { kind: 'ready', avgBytes: entry.avgBytes, sampled: entry.sampled };
  return { kind: 'unavailable' };
}

/**
 * Extra Beebeeb storage for the photos still to do. Nothing left to do is 0
 * whatever the estimate; otherwise it needs a measured average.
 */
export function storageToAdd(view: EstimateView, toCreate: number): number | null {
  if (toCreate <= 0) return 0;
  return view.kind === 'ready' ? Math.round(view.avgBytes * toCreate) : null;
}

/** The settings sample: the newest photo that is not a screenshot, else the newest one. */
export function pickSampleAsset<T extends { mediaSubtypes?: string[] }>(newestFirst: T[]): T | undefined {
  return newestFirst.find((a) => !a.mediaSubtypes?.includes('screenshot')) ?? newestFirst[0];
}
