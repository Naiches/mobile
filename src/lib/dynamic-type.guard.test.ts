// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SOURCE_ROOT = join(ROOT, 'src');

const OPT_OUT_ALLOWLIST: Record<string, string> = {};
const CAP_ALLOWLIST: Record<string, string> = {
  'src/components/NewFileSheet.tsx': 'The extension is a dense label drawn inside a fixed document icon.',
  'src/screens/PhotosScreen.tsx': 'The transient column-count badge is a dense overlay above the photo grid.',
  'src/screens/SpeedtestScreen.tsx': 'The live numeric meter remains readable inside its bounded measurement panel.',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

export function scalingOptOutsIn(source: string): number[] {
  const disabledProp = /allowFontScaling\s*(?:=\s*\{\s*false\s*\}|:\s*false\b|=\s*false\b)/g;
  const globalDefault = /(?:Text|TextInput)\s*\.\s*defaultProps/g;
  const offsets: number[] = [];
  for (const pattern of [disabledProp, globalDefault]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) offsets.push(match.index);
  }
  return offsets;
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function scalingOptOuts(): string[] {
  const hits: string[] = [];

  for (const file of sourceFiles(SOURCE_ROOT)) {
    const rel = relative(ROOT, file);
    const source = readFileSync(file, 'utf8');
    for (const offset of scalingOptOutsIn(source)) hits.push(`${rel}:${lineAt(source, offset)}`);
  }

  return hits;
}

function cappedFiles(): Array<{ path: string; multiplier: number }> {
  const hits: Array<{ path: string; multiplier: number }> = [];
  const capped = /maxFontSizeMultiplier\s*=\s*\{\s*([0-9.]+)\s*\}/g;
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const path = relative(ROOT, file);
    const source = readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = capped.exec(source))) hits.push({ path, multiplier: Number(match[1]) });
  }
  return hits;
}

describe('Dynamic Type source guard', () => {
  test('the scanner catches multiline and global scaling opt-outs', () => {
    expect(scalingOptOutsIn('<Text allowFontScaling={\n false\n}>')).toHaveLength(1);
    expect(scalingOptOutsIn('Text.defaultProps = { allowFontScaling: false }')).toHaveLength(2);
    expect(scalingOptOutsIn('TextInput.defaultProps = defaults')).toHaveLength(1);
  });

  test('the source walk covers the application', () => {
    const files = sourceFiles(SOURCE_ROOT).map((file) => relative(ROOT, file));
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('src/App.tsx');
  });

  test('every exception is current and has a written reason', () => {
    const optOuts = scalingOptOuts();
    const caps = cappedFiles();
    for (const [path, reason] of Object.entries({ ...OPT_OUT_ALLOWLIST, ...CAP_ALLOWLIST })) {
      expect(reason.trim().length, path).toBeGreaterThan(0);
    }
    expect(Object.keys(OPT_OUT_ALLOWLIST).filter((path) => !optOuts.some((hit) => hit.startsWith(`${path}:`)))).toEqual([]);
    expect(Object.keys(CAP_ALLOWLIST).filter((path) => !caps.some((hit) => hit.path === path))).toEqual([]);
  });

  test('app text never disables system font scaling', () => {
    expect(scalingOptOuts().filter((hit) => !OPT_OUT_ALLOWLIST[hit.split(':').slice(0, -1).join(':')])).toEqual([]);
  });

  test('every deliberate cap still allows useful scaling and has a reason', () => {
    const caps = cappedFiles();
    expect(caps.filter(({ path }) => !CAP_ALLOWLIST[path])).toEqual([]);
    expect(caps.filter(({ multiplier }) => multiplier <= 1)).toEqual([]);
  });
});
