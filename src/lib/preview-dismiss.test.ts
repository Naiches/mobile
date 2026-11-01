// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  previewDocumentGestureAction,
  shouldDismissPreview,
} from './preview-dismiss';

const previewScreenSource = readFileSync(
  join(import.meta.dir, '../screens/PreviewScreen.tsx'),
  'utf-8',
);
const codeRendererSource = readFileSync(
  join(import.meta.dir, '../components/preview/CodeRenderer.tsx'),
  'utf-8',
);

const gesture = {
  zoomScale: 1,
  translationX: 4,
  translationY: 140,
  velocityX: 20,
  velocityY: 300,
  documentScrollOffset: 0,
};

describe('preview swipe-to-dismiss decision', () => {
  test('dismisses a fitted preview after a long mostly-vertical downward drag', () => {
    expect(shouldDismissPreview(gesture)).toBe(true);
  });

  test('never dismisses while the media is zoomed', () => {
    expect(shouldDismissPreview({ ...gesture, zoomScale: 1.2 })).toBe(false);
  });

  test('does not steal a horizontal pager swipe', () => {
    expect(shouldDismissPreview({
      ...gesture,
      translationX: 170,
      translationY: 130,
      velocityX: 900,
      velocityY: 700,
    })).toBe(false);
  });

  test('dismisses a short but fast mostly-vertical downward flick', () => {
    expect(shouldDismissPreview({
      ...gesture,
      translationY: 36,
      velocityY: 1_050,
    })).toBe(true);
  });

  test('does not dismiss a document that is scrolled down', () => {
    expect(shouldDismissPreview({ ...gesture, documentScrollOffset: 24 })).toBe(false);
  });

  test('does not dismiss an upward gesture', () => {
    expect(shouldDismissPreview({ ...gesture, translationY: -180, velocityY: -900 })).toBe(false);
  });
});

const documentGesture = {
  startX: 180,
  startY: 240,
  endX: 184,
  endY: 390,
  durationMs: 300,
  zoomScale: 1,
  documentScrollOffsetAtStart: 0,
};

describe('document preview touch fallback', () => {
  test('dismisses a downward drag that starts at the top', () => {
    expect(previewDocumentGestureAction(documentGesture)).toBe('dismiss');
  });

  test('a drag that starts after scrolling keeps scrolling and never toggles chrome', () => {
    expect(previewDocumentGestureAction({
      ...documentGesture,
      documentScrollOffsetAtStart: 48,
    })).toBe('none');
  });

  test('a non-dismiss drag never toggles chrome', () => {
    expect(previewDocumentGestureAction({
      ...documentGesture,
      endX: 250,
      endY: 280,
    })).toBe('none');
  });

  test('an upward drag stays with the document scroller and never toggles chrome', () => {
    expect(previewDocumentGestureAction({
      ...documentGesture,
      endY: 90,
    })).toBe('none');
  });

  test('a short stationary touch remains a chrome toggle', () => {
    expect(previewDocumentGestureAction({
      ...documentGesture,
      endX: 184,
      endY: 244,
      durationMs: 120,
    })).toBe('toggle-chrome');
  });

  test('the document-area ancestor has no touch or responder handlers', () => {
    const testId = previewScreenSource.indexOf('testID="preview-dismiss-gesture"');
    const open = previewScreenSource.lastIndexOf('<View', testId);
    const tag = previewScreenSource.slice(open, previewScreenSource.indexOf('>', testId));

    expect(tag).not.toContain('onTouch');
    expect(tag).not.toContain('ShouldSetResponder');
    expect(tag).not.toContain('onResponder');
  });

  test('text content has a plain ancestor and Markdown observes touches on its ScrollView', () => {
    const start = previewScreenSource.indexOf(') : textContent != null ? (');
    const end = previewScreenSource.indexOf(') : isDocx ? (', start);
    const textSurface = previewScreenSource.slice(start, end);
    const scrollStart = textSurface.indexOf('<ScrollView');
    // Arrow functions contain `=>`, so slicing at the first `>` would stop
    // halfway through the opening tag. The content-container prop follows all
    // touch/scroll callbacks and gives this source contract a stable boundary.
    const scrollTag = textSurface.slice(scrollStart, textSurface.indexOf('contentContainerStyle', scrollStart));

    expect(textSurface).toContain('<View style={styles.fullBleedFill} testID="preview-content-tap">');
    expect(textSurface).not.toContain('<Pressable style={styles.fullBleedFill}');
    expect(scrollTag).toContain('onTouchStart={handleDocumentTouchStart}');
    expect(scrollTag).toContain('onTouchEnd={handleDocumentTouchEnd}');
    expect(scrollTag).toContain('onTouchCancel={handleDocumentTouchCancel}');
    expect(scrollTag).not.toContain('onTouchMove');
    expect(scrollTag).toContain('onScroll={(event) => handleDocumentScrollOffset');
  });

  test('CodeRenderer observes the same touches on its own ScrollView', () => {
    const callStart = previewScreenSource.indexOf('<CodeRenderer', previewScreenSource.indexOf(') : textContent != null ? ('));
    const callTag = previewScreenSource.slice(callStart, previewScreenSource.indexOf('/>', callStart));
    const scrollStart = codeRendererSource.indexOf('<ScrollView');
    const scrollTag = codeRendererSource.slice(scrollStart, codeRendererSource.indexOf('contentContainerStyle', scrollStart));

    for (const prop of ['onTouchStart', 'onTouchEnd', 'onTouchCancel']) {
      expect(callTag).toContain(`${prop}={handleDocument${prop.slice(2)}}`);
      expect(scrollTag).toContain(`${prop}={${prop}}`);
    }
    expect(callTag).not.toContain('onTouchMove');
    expect(scrollTag).not.toContain('onTouchMove');
    expect(scrollTag).toContain('onScroll={(event) => onScrollOffsetChange?.');
  });
});
