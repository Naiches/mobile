// @ts-nocheck — Bun's isolated test runtime types are not part of the app TypeScript project.
import { describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const RUNNER = resolve(import.meta.dir, '../../scripts/test-isolated.mjs');

function runFixture(testSource: string) {
  const root = mkdtempSync(join(tmpdir(), 'test-isolated-guard-'));
  const runner = join(root, 'scripts/test-isolated.mjs');
  const systemTmp = join(root, 'system-tmp');
  const foreignEntry = 'bb-owned-by-another-process';

  try {
    mkdirSync(dirname(runner), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(systemTmp, { recursive: true });
    mkdirSync(join(systemTmp, foreignEntry));
    copyFileSync(RUNNER, runner);
    writeFileSync(join(root, 'src/fixture.test.ts'), testSource);

    const result = spawnSync('bun', ['scripts/test-isolated.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: systemTmp, NODE_OPTIONS: '' },
      timeout: 10_000,
    });

    return {
      error: result.error,
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      remainingTmpEntries: readdirSync(systemTmp).sort(),
      foreignEntry,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('isolated test runner temp guard', () => {
  test('fails, attributes, and removes a leaked bb-* temp folder', () => {
    const result = runFixture(`
      import { expect, test } from 'bun:test';
      import { mkdirSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';

      test('leaks a temp folder', () => {
        expect(tmpdir()).toBe(process.env.TMPDIR!);
        mkdirSync(join(tmpdir(), 'bb-isolated-leak-fixture'));
      });
    `);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'src/fixture.test.ts: bb-isolated-leak-fixture',
    );
    expect(result.output).toMatch(
      /isolated: 1 pass, 0 fail across 1 files .*failed because of 1 leaked temp folder/,
    );
    expect(result.remainingTmpEntries).toEqual([result.foreignEntry]);
  });

  test('keeps the existing truth line unchanged when nothing leaks', () => {
    const result = runFixture(`
      import { expect, test } from 'bun:test';
      import { tmpdir } from 'node:os';
      import { basename, dirname } from 'node:path';

      test('uses the private temp folder', () => {
        expect(tmpdir()).toBe(process.env.TMPDIR!);
        expect(basename(dirname(tmpdir())).startsWith('bb-')).toBe(false);
      });
    `);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.output.trim().split('\n').at(-1)).toBe(
      'isolated: 1 pass, 0 fail across 1 files',
    );
    expect(result.remainingTmpEntries).toEqual([result.foreignEntry]);
  });
});
