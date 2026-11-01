// @ts-nocheck
// Every app-side trash/delete must also drop the ids from the shared File Provider cache,
// otherwise the Files app keeps showing the item until a refresh prunes it.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..');
const CALL = /\b(trashFiles|deleteFile|permanentDeleteFile)\(/;
const REMOVAL = 'removeFromFileProviderCache';
/** Lines after a call within which the removal must appear (same handler). */
const WINDOW = 40;

/** Files whose delete calls are not user-visible deletes, with the reason. */
const ALLOWLIST: Record<string, string> = {
  'lib/api.ts': 'defines the delete helpers; trashFiles falls back to deleteFile internally',
  'lib/trash-with-undo.ts': 'the shared helper awaits File Provider removal after its injected trashFiles call',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('delete paths drop the File Provider cache rows', () => {
  test('every trashFiles / deleteFile / permanentDeleteFile call is followed by removeFromFileProviderCache', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (ALLOWLIST[rel]) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, index) => {
        const code = text.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        if (!CALL.test(text) || /^(export\s+)?(async\s+)?function\b/.test(code)) return;
        const after = lines.slice(index, index + WINDOW).join('\n');
        if (!after.includes(REMOVAL)) offenders.push(`${rel}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('the allowlist entries still exist and carry a reason', () => {
    for (const [rel, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(() => readFileSync(join(SRC, rel), 'utf8')).not.toThrow();
    }
  });
});
