// @ts-nocheck
/**
 * Copy guard: the app suggests only EU-based authenticator apps by name
 * (2FAS, Proton Authenticator). No US brands in any source file.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BANNED = [/google\s+authenticator/i, /\bauthy\b/i, /1password/i, /microsoft\s+authenticator/i];

function walk(dir: string, out: string[] = []) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(full);
  }
  return out;
}

describe('authenticator app suggestions', () => {
  test('no source file names a US authenticator brand', () => {
    const hits: string[] = [];
    for (const f of walk(ROOT)) {
      const text = readFileSync(f, 'utf8');
      for (const re of BANNED) if (re.test(text)) hits.push(`${f}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  test('the 2FA setup screen suggests 2FAS and Proton Authenticator', () => {
    const text = readFileSync(join(ROOT, 'screens', 'TwoFactorSetupScreen.tsx'), 'utf8');
    expect(text).toContain('Use an authenticator app such as 2FAS or Proton Authenticator');
  });
});
