import type { CoachMarkStep } from './coach-marks';

export interface CoachMarkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CoachMarkMeasurable {
  measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
}

export type CoachMarkTabLayout = 'detached-search' | 'equal-five';

export function coachMarkLayoutSignature(
  window: { width: number; height: number; fontScale: number },
  insets: { top: number; right: number; bottom: number; left: number },
): string {
  return [
    window.width,
    window.height,
    window.fontScale,
    insets.top,
    insets.right,
    insets.bottom,
    insets.left,
  ].join(':');
}

/** A measured control replaces its tab fallback; one tip never has two targets. */
export function coachMarkPrimaryRect(
  tab: CoachMarkRect,
  measured: CoachMarkRect | null,
): CoachMarkRect {
  return measured ?? tab;
}

export function measureCoachMarkTarget(
  node: CoachMarkMeasurable,
  timeoutMs = 100,
): Promise<CoachMarkRect | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (rect: CoachMarkRect | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(rect);
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    try {
      node.measureInWindow((x, y, width, height) => {
        finish(width > 0 && height > 0 ? { x, y, width, height } : null);
      });
    } catch {
      finish(null);
    }
  });
}

const TAB_INDEX: Record<CoachMarkStep, number> = {
  drive: 0,
  shared: 1,
  photos: 2,
  settings: 3,
};

/**
 * iOS 26 lays out four main tabs in one pill and Search in its own circle.
 * The tab bar is native, so JS cannot measure its items; these values mirror
 * the system geometry while y remains safe-area relative.
 */
export function coachMarkTabRect(
  step: CoachMarkStep,
  windowWidth: number,
  windowHeight: number,
  safeBottom: number,
  layout: CoachMarkTabLayout = 'detached-search',
): CoachMarkRect {
  if (layout === 'equal-five') {
    const slotWidth = windowWidth / 5;
    const centerX = (TAB_INDEX[step] + 0.5) * slotWidth;
    const width = Math.min(58, slotWidth - 6);
    return {
      x: centerX - width / 2,
      y: windowHeight - safeBottom - 54,
      width,
      height: 49,
    };
  }
  const mainPillStart = 28;
  const slotWidth = Math.max(44, (windowWidth - 128) / 4);
  const centerX = mainPillStart + (TAB_INDEX[step] + 0.5) * slotWidth;
  const width = Math.min(58, slotWidth - 4);
  return {
    x: centerX - width / 2,
    y: windowHeight - safeBottom - 58,
    width,
    height: 52,
  };
}

export function paddedCoachMarkRect(rect: CoachMarkRect, padding = 6): CoachMarkRect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

/** Rectangular cells that dim the window while leaving every target transparent. */
export function coachMarkDimCells(
  windowWidth: number,
  windowHeight: number,
  holes: readonly CoachMarkRect[],
): CoachMarkRect[] {
  const xs = new Set([0, windowWidth]);
  const ys = new Set([0, windowHeight]);
  for (const hole of holes) {
    xs.add(Math.max(0, hole.x));
    xs.add(Math.min(windowWidth, hole.x + hole.width));
    ys.add(Math.max(0, hole.y));
    ys.add(Math.min(windowHeight, hole.y + hole.height));
  }
  const xValues = [...xs].sort((a, b) => a - b);
  const yValues = [...ys].sort((a, b) => a - b);
  const cells: CoachMarkRect[] = [];
  for (let yi = 0; yi < yValues.length - 1; yi += 1) {
    for (let xi = 0; xi < xValues.length - 1; xi += 1) {
      const x = xValues[xi];
      const y = yValues[yi];
      const width = xValues[xi + 1] - x;
      const height = yValues[yi + 1] - y;
      if (width <= 0 || height <= 0) continue;
      const centerX = x + width / 2;
      const centerY = y + height / 2;
      if (holes.some((hole) => centerX >= hole.x && centerX <= hole.x + hole.width && centerY >= hole.y && centerY <= hole.y + hole.height)) continue;
      cells.push({ x, y, width, height });
    }
  }
  return cells;
}
