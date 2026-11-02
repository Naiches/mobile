/**
 * Follow an opaque `next_cursor` until the source reports the last page (or a
 * safety cap is hit), accumulating every item in order. The cursor is a black
 * box — we only ever pass back whatever the previous page returned, never parse
 * it (task 0739 keyset pagination). `fetchPage(undefined)` fetches the first page.
 *
 * `maxTotal` and `maxPages` are outer bounds so a pathological or hostile
 * listing can't loop unbounded or exhaust memory; on hitting either we stop and
 * warn (the caller decides whether a truncated set is acceptable for its use).
 *
 * Mirrors repos/web/src/lib/paginate.ts (task 0755 — same loop, shared core logic).
 */
export const DEFAULT_PAGINATION_MAX_PAGES = 1_000;

export async function collectPaged<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
  maxTotal: number,
  label = 'collectPaged',
  maxPages = DEFAULT_PAGINATION_MAX_PAGES,
): Promise<T[]> {
  const all: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  do {
    const { items, nextCursor } = await fetchPage(cursor);
    pageCount += 1;
    all.push(...items);
    if (all.length >= maxTotal) {
      if (nextCursor) {
        console.warn(`[${label}] hit ${maxTotal}-item cap — listing truncated`);
      }
      return all.slice(0, maxTotal);
    }

    if (!nextCursor) return all;
    if (items.length === 0) {
      console.warn(`[${label}] page made no progress — listing truncated`);
      return all;
    }
    if (seenCursors.has(nextCursor)) {
      console.warn(`[${label}] repeated cursor — listing truncated`);
      return all;
    }
    if (pageCount >= maxPages) {
      console.warn(`[${label}] hit ${maxPages}-page cap — listing truncated`);
      return all;
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  return all;
}

/**
 * Walk pages following `next_cursor`, returning the FIRST item the (possibly
 * async) predicate matches — stopping immediately on match (early-exit). Use for
 * by-name/by-id LOOKUPS where scanning/decrypting the whole vault would be
 * wasteful (task 0755). Returns `undefined` if no page matches before the cursor
 * is exhausted. A truncated single-page lookup would silently miss a target past
 * page 1 — this never does.
 *
 * `maxItems` and `maxPages` are outer bounds (mirroring collectPaged) so a
 * pathological or hostile listing whose `next_cursor` never goes null can't
 * loop unbounded; on hitting either without a match we stop and warn, returning
 * `undefined`.
 */
export async function findInPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
  match: (item: T) => boolean | Promise<boolean>,
  maxItems = 50_000,
  maxPages = DEFAULT_PAGINATION_MAX_PAGES,
): Promise<T | undefined> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let scanned = 0;
  let pageCount = 0;
  do {
    const { items, nextCursor } = await fetchPage(cursor);
    pageCount += 1;
    for (const item of items) {
      if (await match(item)) return item;
      if (++scanned >= maxItems) {
        console.warn(`[findInPages] scanned ${maxItems} items without a match — stopping`);
        return undefined;
      }
    }

    if (!nextCursor) return undefined;
    if (items.length === 0) {
      console.warn('[findInPages] page made no progress — stopping');
      return undefined;
    }
    if (seenCursors.has(nextCursor)) {
      console.warn('[findInPages] repeated cursor — stopping');
      return undefined;
    }
    if (pageCount >= maxPages) {
      console.warn(`[findInPages] hit ${maxPages}-page cap — stopping`);
      return undefined;
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  return undefined;
}
