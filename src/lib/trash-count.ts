/**
 * How many items are in Trash, for the "Trash · N items" row at the end of the Drive root.
 * Module-level so every screen that changes Trash (delete, Undo, restore, empty, sync) can
 * refresh it and the Drive root re-renders. Dependency-free: callers pass the counter.
 */
import { useEffect, useState } from 'react';
import { DEVICE_MANIFEST_NAME, hideDeviceManifests } from './hidden-system-files';

export interface TrashProjectionItem {
  id: string;
  parent_id?: string | null;
  is_folder?: boolean;
}

/** A synchronous lookup over state already held on-device (sync tree or index cache). */
export type TrashParentLookup = (id: string) => string | null | undefined;

/** Build a local parent cache without turning an omitted production field into root. */
export function knownTrashParentMap(
  entries: readonly TrashProjectionItem[],
): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  for (const entry of entries) {
    if (entry.parent_id !== undefined) parents.set(entry.id, entry.parent_id);
  }
  return parents;
}

function resolveTrashParentIds(
  ids: readonly string[],
  parentById: Map<string, string | null>,
  parentOf?: TrashParentLookup,
): Set<string> {
  const unresolved = new Set<string>();
  for (const id of new Set(ids)) {
    if (parentById.has(id)) continue;
    let parentId: string | null | undefined;
    try {
      parentId = parentOf?.(id);
    } catch {
      // A stale/corrupt local cache is the same as a miss for first paint.
      parentId = undefined;
    }
    if (parentId === undefined) unresolved.add(id);
    else parentById.set(id, parentId);
  }
  return unresolved;
}

export interface TopLevelTrashProjection<T> {
  /** Confirmed roots plus unresolved rows kept for an immediate, provisional paint. */
  topLevel: T[];
  /** Parent ids known from the listing or the synchronous local lookup. */
  parentById: ReadonlyMap<string, string | null>;
  /** Ids whose parent is not available locally. */
  unresolvedParentIds: string[];
  /** True when every parent needed by this projection was available locally. */
  complete: boolean;
  /** Exact root count, or null rather than a guessed count. */
  count: number | null;
}

function trashTopLevelProjection<T extends TrashProjectionItem>(
  entries: readonly T[],
  parentOf?: TrashParentLookup,
): TopLevelTrashProjection<T> {
  const parentById = knownTrashParentMap(entries);
  const unresolved = resolveTrashParentIds(entries.map((entry) => entry.id), parentById, parentOf);

  const trashedIds = new Set(entries.map((entry) => entry.id));
  const topLevel = entries.filter((entry) => {
    // Keep an unresolved row paintable. It may be collapsed after a bounded
    // background revalidation, but it must never trigger network work here.
    if (!parentById.has(entry.id)) return true;
    const parentId = parentById.get(entry.id);
    return !parentId || !trashedIds.has(parentId);
  });
  const complete = unresolved.size === 0;
  return {
    topLevel,
    parentById,
    unresolvedParentIds: [...unresolved],
    complete,
    count: complete ? topLevel.length : null,
  };
}

/**
 * Project the server's flat all-Trash response to the rows a person actually
 * trashed. A descendant is not a second Trash row when its parent is also
 * trashed. Missing server parent ids may be resolved only from a synchronous
 * on-device lookup. Unknown rows remain paintable, but make the count null.
 */
export function projectTopLevelTrashItems<T extends TrashProjectionItem>(
  entries: readonly T[],
  parentOf?: TrashParentLookup,
): TopLevelTrashProjection<T> {
  return trashTopLevelProjection(entries, parentOf);
}

export interface VisibleTrashProjection<T> {
  /** Rows shown in Trash and counted by the Drive root. */
  visible: T[];
  /** Invisible top-level system rows retained so Empty Trash can purge them. */
  hidden: T[];
  /** Every top-level row before applying the shared system-file rule. */
  topLevel: T[];
  /** Parent ids unavailable from both the response and local state. */
  unresolvedParentIds: string[];
  /** Whether the projection is authoritative rather than provisional. */
  complete: boolean;
  /** Exact visible count, or null when parent resolution is incomplete. */
  count: number | null;
}

/**
 * The single authoritative Trash projection used by both the Drive counter
 * and the Trash list: collapse descendants, then hide internal backup
 * manifests. Hidden top-level rows are returned separately for cleanup.
 */
export async function projectVisibleTopLevelTrashItems<T extends TrashProjectionItem>(
  entries: readonly T[],
  parentOf: TrashParentLookup | undefined,
  nameOf: (entry: T) => Promise<string | null | undefined> | string | null | undefined,
): Promise<VisibleTrashProjection<T>> {
  const base = trashTopLevelProjection(entries, parentOf);
  const { topLevel } = base;
  const parentById = new Map(base.parentById);
  const names = new Map<string, string | null | undefined>();
  await Promise.all(topLevel.map(async (entry) => {
    names.set(entry.id, await nameOf(entry));
  }));

  // A visible top-level manifest can still live under an active device folder.
  // Resolve that folder so the shared hide rule can verify its Backups parent.
  const manifestParentIds = topLevel
    .filter((entry) => !entry.is_folder && names.get(entry.id) === DEVICE_MANIFEST_NAME)
    .map((entry) => parentById.get(entry.id))
    .filter((id): id is string => !!id);
  const unresolved = new Set(base.unresolvedParentIds);
  for (const id of resolveTrashParentIds(manifestParentIds, parentById, parentOf)) {
    unresolved.add(id);
  }

  // A trashed legacy Backups root is no longer the globally protected root,
  // but its manifests remain system files too.
  const trashedBackupsRoots = new Set(
    topLevel
      .filter((entry) => entry.is_folder && names.get(entry.id) === 'Backups' && parentById.has(entry.id) && parentById.get(entry.id) === null)
      .map((entry) => entry.id.toLowerCase()),
  );
  const visible = hideDeviceManifests(
    topLevel,
    (entry) => names.get(entry.id),
    (id) => parentById.get(id),
    trashedBackupsRoots,
  );
  const visibleIds = new Set(visible.map((entry) => entry.id));
  const complete = unresolved.size === 0;
  return {
    visible,
    hidden: topLevel.filter((entry) => !visibleIds.has(entry.id)),
    topLevel,
    unresolvedParentIds: [...unresolved],
    complete,
    count: complete ? visible.length : null,
  };
}

let count: number | null = null;
let generation = 0;
const listeners = new Set<() => void>();

export function getTrashCount(): number | null {
  return count;
}

export function setTrashCount(next: number | null): void {
  generation += 1;
  if (next === count) return;
  count = next;
  listeners.forEach((listener) => listener());
}

export function adjustTrashCount(delta: number): void {
  if (count === null || delta === 0) return;
  setTrashCount(Math.max(0, count + delta));
}

export function subscribeTrashCount(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-count with `counter`; a failure keeps the last known value, a stale answer is dropped. */
export async function refreshTrashCount(counter: () => Promise<number | null>): Promise<void> {
  const mine = ++generation;
  try {
    const next = await counter();
    if (mine !== generation) return;
    setTrashCount(next);
  } catch {
    // keep the last known count; the next refresh corrects it
  }
}

let defaultCounter: (() => Promise<number | null>) | null = null;

/** The app registers how to count Trash once; `notifyTrashChanged` then refreshes with it. */
export function setTrashCounter(counter: () => Promise<number | null>): void {
  defaultCounter = counter;
}

export function notifyTrashChanged(): void {
  if (defaultCounter) void refreshTrashCount(defaultCounter);
}

export function useTrashCount(): number | null {
  const [value, setValue] = useState(count);
  useEffect(() => {
    setValue(count);
    return subscribeTrashCount(() => setValue(count));
  }, []);
  return value;
}

export function shouldShowTrashRow({ isRoot, selectMode, searchActive }: { isRoot: boolean; selectMode: boolean; searchActive: boolean }): boolean {
  return isRoot && !selectMode && !searchActive;
}

export function trashRowLabel(n: number | null): string {
  if (n === null) return 'Trash';
  return `Trash · ${n} item${n === 1 ? '' : 's'}`;
}
