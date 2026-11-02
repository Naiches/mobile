export const TRASH_BACKGROUND_MAX_PAGES = 250;

interface TrashPage<T> {
  items: T[];
  nextCursor: string | null;
}

interface TrashPaginationOptions<T extends { id: string }> {
  /** Rows already painted from the first request. */
  initialItems: readonly T[];
  /** Cursor returned with that first request. */
  initialNextCursor: string | null;
  fetchPage: (cursor: string) => Promise<TrashPage<T>>;
  /** Publishes each successfully accumulated partial result without awaiting UI work. */
  onPage?: (items: T[]) => void;
  /** Stops superseded/unmounted screen generations without surfacing an error. */
  isCancelled?: () => boolean;
  /** Includes the already-loaded first page. */
  maxPages?: number;
}

export interface TrashPaginationResult<T> {
  items: T[];
  complete: boolean;
}

/**
 * Continue Trash pagination after its first page is already visible.
 *
 * The server cursor is opaque, so termination cannot depend on parsing it.
 * Instead we bound page count, reject cursor cycles, and require every page
 * that advertises a successor to add at least one previously unseen row.
 */
export async function paginateTrashInBackground<T extends { id: string }>(
  options: TrashPaginationOptions<T>,
): Promise<TrashPaginationResult<T>> {
  const maxPages = options.maxPages ?? TRASH_BACKGROUND_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error('Trash pagination maxPages must be at least 1.');
  }

  const byId = new Map(options.initialItems.map((item) => [item.id, item]));
  const snapshot = (): T[] => [...byId.values()];
  const seenCursors = new Set<string>();
  let cursor = options.initialNextCursor;
  let pagesLoaded = 1;

  while (cursor) {
    if (options.isCancelled?.()) return { items: snapshot(), complete: false };
    if (pagesLoaded >= maxPages) {
      throw new Error(`Trash pagination hit its ${maxPages}-page cap before completion.`);
    }
    if (seenCursors.has(cursor)) {
      throw new Error('Trash pagination repeated a cursor before completion.');
    }
    seenCursors.add(cursor);

    const page = await options.fetchPage(cursor);
    if (options.isCancelled?.()) return { items: snapshot(), complete: false };

    let added = 0;
    for (const item of page.items) {
      if (!byId.has(item.id)) added += 1;
      byId.set(item.id, item);
    }
    pagesLoaded += 1;
    const items = snapshot();
    options.onPage?.(items);

    if (page.nextCursor && added === 0) {
      throw new Error('Trash pagination made no progress before advertising another page.');
    }
    if (page.nextCursor && seenCursors.has(page.nextCursor)) {
      throw new Error('Trash pagination repeated a cursor before completion.');
    }
    cursor = page.nextCursor;
  }

  return { items: snapshot(), complete: true };
}
