#!/usr/bin/env bun
/**
 * Per-file isolated test runner (task 0877).
 *
 * Why this exists: bun 1.3.4 registers `mock.module()` on a PROCESS-GLOBAL registry that is
 * never reset between test files, and `mock.restore()` does not undo it. The first file to
 * register a specifier wins for the whole run, so two files mocking the same module
 * differently corrupt each other. Concretely: `api-client-session.test.ts` registers
 * `mock.module('expo-file-system', () => ({}))` (empty), which starves `welcome-seed.test.ts`
 * of `cacheDirectory` and makes it skip seeding -> 10 phantom failures in the full suite that
 * all pass when their file is run alone.
 *
 * Jest solves this by giving every test file its own module registry. bun has no such flag,
 * so we get the same semantics the only way available: one `bun test` process per file.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SEARCH_DIRS = ['src', '__tests__', 'app'];
const CONCURRENCY = 6;

function snapshotBbEntries(dir) {
  try {
    return {
      entries: new Set(readdirSync(dir).filter((entry) => entry.startsWith('bb-'))),
      error: null,
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { entries: new Set(), error: null };
    }
    return { entries: new Set(), error: `could not scan ${dir}: ${errorText(error)}` };
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function removeOwnedTemp(path) {
  try {
    rmSync(path, { recursive: true, force: true });
    return null;
  } catch (error) {
    return `could not remove ${path}: ${errorText(error)}`;
  }
}

function collectTestFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTestFiles(full, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = SEARCH_DIRS.flatMap((d) => collectTestFiles(join(ROOT, d))).sort();

if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}

// NODE_OPTIONS is stripped: a stale cmux `restore-node-options.cjs` preload crashes node/bun.
const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;

const runTmp = mkdtempSync(join(tmpdir(), 'test-isolated-'));
let tempCursor = 0;
let runTmpRemoved = false;

function cleanupRunTmp() {
  if (runTmpRemoved) return;
  runTmpRemoved = removeOwnedTemp(runTmp) === null;
}

process.once('exit', cleanupRunTmp);
process.once('SIGINT', () => {
  cleanupRunTmp();
  process.exit(130);
});
process.once('SIGTERM', () => {
  cleanupRunTmp();
  process.exit(143);
});

async function runFile(file) {
  const fileTmp = join(runTmp, `file-${tempCursor++}`);
  const tempGuardErrors = [];
  try {
    mkdirSync(fileTmp);
  } catch (error) {
    return {
      file: relative(ROOT, file),
      pass: 0,
      fail: 0,
      exitCode: 1,
      output: `could not create private temp folder: ${errorText(error)}\n`,
      leakedTempFolders: [],
      tempGuardErrors: [`could not create ${fileTmp}: ${errorText(error)}`],
    };
  }
  const before = snapshotBbEntries(fileTmp);
  if (before.error) tempGuardErrors.push(before.error);
  let output = '';
  let exitCode = 1;

  try {
    const proc = Bun.spawn(['bun', 'test', file], {
      cwd: ROOT,
      env: { ...childEnv, TMPDIR: fileTmp, TMP: fileTmp, TEMP: fileTmp },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, childExitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    output = stdout + stderr;
    exitCode = childExitCode;
  } catch (error) {
    output = `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`;
  }

  const after = snapshotBbEntries(fileTmp);
  if (after.error) tempGuardErrors.push(after.error);
  const leakedTempFolders = [...after.entries]
    .filter((entry) => !before.entries.has(entry))
    .sort();
  for (const entry of leakedTempFolders) {
    const removeError = removeOwnedTemp(join(fileTmp, entry));
    if (removeError) tempGuardErrors.push(removeError);
  }
  const fileTmpRemoveError = removeOwnedTemp(fileTmp);
  if (fileTmpRemoveError) tempGuardErrors.push(fileTmpRemoveError);

  const pass = Number(output.match(/^\s*(\d+) pass$/m)?.[1] ?? 0);
  const fail = Number(output.match(/^\s*(\d+) fail$/m)?.[1] ?? 0);
  return {
    file: relative(ROOT, file),
    pass,
    fail,
    exitCode,
    output,
    leakedTempFolders,
    tempGuardErrors,
  };
}

try {
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        const result = await runFile(file);
        results.push(result);
        const mark =
          result.fail === 0 &&
          result.exitCode === 0 &&
          result.leakedTempFolders.length === 0 &&
          result.tempGuardErrors.length === 0
            ? 'ok  '
            : 'FAIL';
        console.log(`${mark} ${result.file}  (${result.pass} pass, ${result.fail} fail)`);
      }
    }),
  );

  const broken = results.filter(
    (r) =>
      r.fail > 0 ||
      r.exitCode !== 0 ||
      r.leakedTempFolders.length > 0 ||
      r.tempGuardErrors.length > 0,
  );
  for (const r of broken) {
    const guardOutput = r.tempGuardErrors.map((error) => `temp guard: ${error}`).join('\n');
    console.log(
      `\n${'='.repeat(70)}\n${r.file}\n${'='.repeat(70)}\n${r.output}` +
        (guardOutput ? `${guardOutput}\n` : ''),
    );
  }

  const leaking = results.filter((r) => r.leakedTempFolders.length > 0);
  const leakedTempFolderCount = leaking.reduce((count, r) => count + r.leakedTempFolders.length, 0);
  if (leaking.length > 0) {
    console.log(`\nleaked temp folders: ${leakedTempFolderCount}`);
    for (const result of leaking) {
      console.log(`  ${result.file}: ${result.leakedTempFolders.join(', ')}`);
    }
  }

  const runTmpCleanupError = removeOwnedTemp(runTmp);
  runTmpRemoved = runTmpCleanupError === null;
  if (runTmpCleanupError) console.log(`FAIL temp guard cleanup: ${runTmpCleanupError}`);
  const tempGuardFailed =
    runTmpCleanupError !== null || results.some((result) => result.tempGuardErrors.length > 0);

  const totalPass = results.reduce((n, r) => n + r.pass, 0);
  const totalFail = results.reduce((n, r) => n + r.fail, 0);
  console.log(
    `\nisolated: ${totalPass} pass, ${totalFail} fail across ${results.length} files` +
      (broken.length ? ` — ${broken.length} file(s) failing` : '') +
      (leakedTempFolderCount > 0
        ? ` — failed because of ${leakedTempFolderCount} leaked temp folder(s)`
        : '') +
      (tempGuardFailed ? ' — failed because temp guard cleanup failed' : ''),
  );
  process.exitCode = broken.length || tempGuardFailed ? 1 : 0;
} finally {
  if (!runTmpRemoved) removeOwnedTemp(runTmp);
}
