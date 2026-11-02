import { useSyncExternalStore } from 'react';

type OptimisticTrashState = 'pending' | 'confirmed';

let state = new Map<string, OptimisticTrashState>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const confirmedExpiry = new Map<string, ReturnType<typeof setTimeout>>();
const CONFIRMED_HIDE_MAX_MS = 30_000;

function publish(): void {
  snapshot = new Set(state.keys());
  listeners.forEach((listener) => listener());
}

export function hideOptimisticallyTrashed(ids: readonly string[]): void {
  let changed = false;
  for (const id of ids) {
    const expiry = confirmedExpiry.get(id);
    if (expiry) clearTimeout(expiry);
    confirmedExpiry.delete(id);
    if (state.get(id) === 'pending') continue;
    state.set(id, 'pending');
    changed = true;
  }
  if (changed) publish();
}

/** Keep rows hidden while the sync tree catches up to a completed server request. */
export function confirmOptimisticallyTrashed(ids: readonly string[]): void {
  let changed = false;
  for (const id of ids) {
    if (!state.has(id) || state.get(id) === 'confirmed') continue;
    state.set(id, 'confirmed');
    const expiry = setTimeout(() => revealOptimisticallyTrashed([id]), CONFIRMED_HIDE_MAX_MS);
    confirmedExpiry.set(id, expiry);
    changed = true;
  }
  if (changed) publish();
}

export function revealOptimisticallyTrashed(ids: readonly string[]): void {
  let changed = false;
  for (const id of ids) {
    const expiry = confirmedExpiry.get(id);
    if (expiry) clearTimeout(expiry);
    confirmedExpiry.delete(id);
    changed = state.delete(id) || changed;
  }
  if (changed) publish();
}

export function revealConfirmedOptimisticTrash(): void {
  const confirmed = [...state].filter(([, value]) => value === 'confirmed').map(([id]) => id);
  revealOptimisticallyTrashed(confirmed);
}

export function clearOptimisticTrash(): void {
  if (state.size === 0) return;
  for (const expiry of confirmedExpiry.values()) clearTimeout(expiry);
  confirmedExpiry.clear();
  state = new Map();
  publish();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useOptimisticallyTrashedIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
