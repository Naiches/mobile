// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig.
import { describe, expect, test } from 'bun:test';
import { paginateTrashInBackground } from './trash-pagination';

type Row = { id: string };

describe('paginateTrashInBackground', () => {
  test('publishes each additional page while preserving first-page rows', async () => {
    const published: string[][] = [];
    const cursors: string[] = [];
    const result = await paginateTrashInBackground<Row>({
      initialItems: [{ id: 'first' }],
      initialNextCursor: 'page-2',
      fetchPage: async (cursor) => {
        cursors.push(cursor);
        return cursor === 'page-2'
          ? { items: [{ id: 'second' }], nextCursor: 'page-3' }
          : { items: [{ id: 'third' }], nextCursor: null };
      },
      onPage: (items) => published.push(items.map((item) => item.id)),
    });

    expect(cursors).toEqual(['page-2', 'page-3']);
    expect(published).toEqual([
      ['first', 'second'],
      ['first', 'second', 'third'],
    ]);
    expect(result).toEqual({
      items: [{ id: 'first' }, { id: 'second' }, { id: 'third' }],
      complete: true,
    });
  });

  test('rejects a repeated cursor instead of looping forever', async () => {
    let calls = 0;
    const request = paginateTrashInBackground<Row>({
      initialItems: [{ id: 'first' }],
      initialNextCursor: 'same',
      fetchPage: async () => {
        calls += 1;
        if (calls > 2) throw new Error('unbounded pagination');
        return { items: [{ id: `row-${calls}` }], nextCursor: 'same' };
      },
    });

    await expect(request).rejects.toThrow('repeated a cursor');
    expect(calls).toBe(1);
  });

  test('rejects a page that adds no new ids while advertising another page', async () => {
    let calls = 0;
    const request = paginateTrashInBackground<Row>({
      initialItems: [{ id: 'first' }],
      initialNextCursor: 'page-2',
      fetchPage: async () => {
        calls += 1;
        return { items: [{ id: 'first' }], nextCursor: 'page-3' };
      },
    });

    await expect(request).rejects.toThrow('made no progress');
    expect(calls).toBe(1);
  });

  test('rejects at the page cap while keeping pagination bounded', async () => {
    let calls = 0;
    const request = paginateTrashInBackground<Row>({
      initialItems: [{ id: 'first' }],
      initialNextCursor: '1',
      maxPages: 3,
      fetchPage: async (cursor) => {
        calls += 1;
        return { items: [{ id: `row-${cursor}` }], nextCursor: String(Number(cursor) + 1) };
      },
    });

    await expect(request).rejects.toThrow('3-page cap');
    expect(calls).toBe(2); // first page + two background pages = three total
  });

  test('stops quietly when the owning screen cancels the generation', async () => {
    let cancelled = false;
    let calls = 0;
    const result = await paginateTrashInBackground<Row>({
      initialItems: [{ id: 'first' }],
      initialNextCursor: 'page-2',
      isCancelled: () => cancelled,
      fetchPage: async () => {
        calls += 1;
        cancelled = true;
        return { items: [{ id: 'second' }], nextCursor: 'page-3' };
      },
    });

    expect(calls).toBe(1);
    expect(result).toEqual({ items: [{ id: 'first' }], complete: false });
  });
});
