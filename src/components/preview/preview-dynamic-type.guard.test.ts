// @ts-nocheck — isolated Bun source guard; Expo's native renderer is not loaded.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = (name: string) => readFileSync(join(import.meta.dir, name), 'utf8');

function styleBlock(text: string, name: string): string {
  const match = text.match(new RegExp(`\\n  ${name}: \\{([\\s\\S]*?)\\n  \\},`));
  expect(match, `${name} style exists`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('preview Dynamic Type layout guards', () => {
  test('presentation slide copy remains vertically reachable after it scales', () => {
    const text = source('PptxRenderer.tsx');
    expect(text).toMatch(/<ScrollView\s+style=\{styles\.slideContent\}\s+contentContainerStyle=\{styles\.slideContentInner\}/);
    expect(styleBlock(text, 'slideContent')).toContain('flex: 1');
  });

  test('the RAW caption wraps within the screen and clears enlarged preview chrome', () => {
    const text = source('RawRenderer.tsx');
    const layer = styleBlock(text, 'captionLayer');
    expect(text).toMatch(/useWindowDimensions\(\)/);
    expect(text).toMatch(/largeText\s*&&\s*styles\.captionLayerLargeText/);
    expect(layer).toContain('left: 16');
    expect(layer).toContain('right: 16');
    expect(styleBlock(text, 'captionLayerLargeText')).toMatch(/bottom:\s*1[0-9]{2}/);
    expect(styleBlock(text, 'captionWrap')).toContain("maxWidth: '100%'");
    expect(styleBlock(text, 'captionText')).toContain("textAlign: 'center'");
  });

  test('scaled ordered-list markers can grow beyond their default gutter', () => {
    const marker = styleBlock(source('MarkdownRenderer.tsx'), 'listMarker');
    expect(marker).toContain('minWidth: 20');
    expect(marker).not.toMatch(/(^|\n)\s*width:\s*20/);
  });
});
