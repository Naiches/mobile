export const IOS_NATIVE_BACK_EDGE_WIDTH = 24;

const IOS_FILE_ROW_HIT_SLOP = { left: -IOS_NATIVE_BACK_EDGE_WIDTH };

/**
 * Negative gesture-handler hit slop shrinks the pan recognizer's bounds.
 * Keep the system back edge out of the row recognizer on iOS.
 */
export function fileRowSwipeHitSlop(platform: string): { left: number } | undefined {
  return platform === 'ios' ? IOS_FILE_ROW_HIT_SLOP : undefined;
}
