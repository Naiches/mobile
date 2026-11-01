// @ts-nocheck — Bun test types are not part of the app TypeScript environment.
import { expect, test } from 'bun:test';
import { decryptNamesInBackground } from './background-name-decrypt';
const items = Array.from({ length: 25 }, (_, i) => ({ fileId: String(i), nameEncrypted: '{}' }));
const result = (name: string) => ({ name, mimeType: null, error: null });

test('25 missing names use one bounded native batch with a browsing yield first', async () => {
  const calls: string[] = [];
  const applied: string[] = [];
  const count = await decryptNamesInBackground(items, async (batch) => {
    calls.push(`decrypt:${batch.length}`);
    return batch.map((item) => result(item.fileId));
  }, (item) => applied.push(item.fileId), () => false, async () => { calls.push('yield'); });
  expect(calls).toEqual(['yield', 'decrypt:25']);
  expect(count).toBe(25);
  expect(applied).toEqual(items.map((item) => item.fileId));
});

test('blur or lock during yield queues zero native work', async () => {
  let cancelled = false;
  let calls = 0;
  const count = await decryptNamesInBackground(items, async () => { calls++; return []; }, () => {}, () => cancelled, async () => { cancelled = true; });
  expect(count).toBe(0);
  expect(calls).toBe(0);
});

test('blur or account purge during native decrypt applies zero names', async () => {
  let cancelled = false;
  const applied: string[] = [];
  const count = await decryptNamesInBackground(items, async (batch) => {
    cancelled = true;
    return batch.map((item) => result(item.fileId));
  }, (item) => applied.push(item.fileId), () => cancelled, async () => {});
  expect(count).toBe(0);
  expect(applied).toEqual([]);
});

test('individual auth failures are skipped without borrowing another row name', async () => {
  const applied: string[] = [];
  expect(await decryptNamesInBackground(items.slice(0, 3), async () => [result('first'), { name: null, mimeType: null, error: 'auth' }, result('third')], (item, name) => applied.push(`${item.fileId}:${name.name}`), () => false, async () => {})).toBe(2);
  expect(applied).toEqual(['0:first', '2:third']);
});

test('a 5,000-row reconcile bulk-applies bounded batches instead of updating the whole index per row', async () => {
  const largeVault = Array.from({ length: 5_000 }, (_, i) => ({ fileId: String(i), nameEncrypted: '{}' }));
  let decryptCalls = 0;
  let bulkApplyCalls = 0;
  let individualApplyCalls = 0;
  let yields = 0;

  const applied = await decryptNamesInBackground(
    largeVault,
    async (batch) => {
      decryptCalls += 1;
      return batch.map((item) => result(item.fileId));
    },
    () => { individualApplyCalls += 1; },
    () => false,
    async () => { yields += 1; },
    () => { bulkApplyCalls += 1; },
  );

  expect(applied).toBe(5_000);
  expect(decryptCalls).toBeLessThanOrEqual(50);
  expect(yields).toBe(decryptCalls);
  expect(bulkApplyCalls).toBe(decryptCalls);
  expect(individualApplyCalls).toBe(0);
});
