export const PREVIEW_DISMISS_DISTANCE = 120;
export const PREVIEW_DISMISS_VELOCITY = 800;
const FIT_SCALE_TOLERANCE = 0.01;
const VERTICAL_DOMINANCE = 1.2;
const SCROLL_TOP_TOLERANCE = 1;
const PREVIEW_TAP_MOVEMENT_TOLERANCE = 10;
const TAP_DURATION_MS = 500;

export interface PreviewDismissInput {
  zoomScale: number;
  translationX: number;
  translationY: number;
  velocityX: number;
  velocityY: number;
  documentScrollOffset: number;
}

export interface PreviewDocumentGestureInput {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  durationMs: number;
  zoomScale: number;
  documentScrollOffsetAtStart: number;
}

export type PreviewDocumentGestureAction = 'dismiss' | 'toggle-chrome' | 'none';

/**
 * Decide whether a completed preview drag may dismiss the routed modal.
 * Kept renderer-agnostic so image zoom, the photo pager and document scroll
 * offsets all follow the same thresholds.
 */
export function shouldDismissPreview(input: PreviewDismissInput): boolean {
  if (input.zoomScale > 1 + FIT_SCALE_TOLERANCE) return false;
  if (input.documentScrollOffset > SCROLL_TOP_TOLERANCE) return false;
  if (input.translationY <= 0 && input.velocityY <= 0) return false;

  const distanceMostlyVertical =
    input.translationY > Math.abs(input.translationX) * VERTICAL_DOMINANCE;
  const velocityMostlyVertical =
    input.velocityY > Math.abs(input.velocityX) * VERTICAL_DOMINANCE;
  if (!distanceMostlyVertical && !velocityMostlyVertical) return false;

  return input.translationY >= PREVIEW_DISMISS_DISTANCE ||
    (input.velocityY >= PREVIEW_DISMISS_VELOCITY && velocityMostlyVertical);
}

/**
 * Classify the raw touch sequence observed by a document renderer's own
 * ScrollView without claiming its native pan responder.
 */
export function previewDocumentGestureAction(
  input: PreviewDocumentGestureInput,
): PreviewDocumentGestureAction {
  const translationX = input.endX - input.startX;
  const translationY = input.endY - input.startY;
  const durationMs = Math.max(1, input.durationMs);

  if (shouldDismissPreview({
    zoomScale: input.zoomScale,
    translationX,
    translationY,
    velocityX: (translationX / durationMs) * 1_000,
    velocityY: (translationY / durationMs) * 1_000,
    documentScrollOffset: input.documentScrollOffsetAtStart,
  })) {
    return 'dismiss';
  }

  if (
    Math.abs(translationX) < PREVIEW_TAP_MOVEMENT_TOLERANCE &&
    Math.abs(translationY) < PREVIEW_TAP_MOVEMENT_TOLERANCE &&
    input.durationMs < TAP_DURATION_MS
  ) {
    return 'toggle-chrome';
  }

  return 'none';
}
