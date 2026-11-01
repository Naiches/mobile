/**
 * The root "Backups" folder is a protected system folder: it cannot be deleted, renamed or moved
 * (in the app or in the Files app). Everything inside it is managed as normal.
 *
 * It is identified by id, never by name. BackupService knows the id (it resolves the root with
 * its find-or-create / duplicate-merge logic) and publishes it here; the Files app extension
 * learns it through the shared cache (`setFileProviderProtectedBackupsRoot`).
 *
 * Dependency-free on purpose: screens, the backup service and the sign-out cleanup all import it.
 */
export const BACKUPS_PROTECTED_MESSAGE = "Backups is a system folder and can't be deleted.";
export const BACKUPS_PROTECTED_MOVE_MESSAGE = "Backups is a system folder and can't be moved.";

let protectedRootId: string | null = null;
const listeners = new Set<() => void>();

const normalise = (id: string | null | undefined): string | null => (id ? id.toLowerCase() : null);

export function getProtectedBackupsRootId(): string | null {
  return protectedRootId;
}

export function setProtectedBackupsRootId(id: string | null | undefined): void {
  const next = normalise(id);
  if (next === protectedRootId) return;
  protectedRootId = next;
  listeners.forEach((listener) => listener());
}

export function isProtectedBackupsRoot(id: string | null | undefined): boolean {
  const key = normalise(id);
  return key !== null && key === protectedRootId;
}

export function subscribeProtectedBackupsRoot(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** For delete / move of a selection: the ids that may go ahead, and whether the root was dropped. */
export function partitionProtectedBackupsRoot(ids: string[]): { allowed: string[]; skippedProtected: boolean } {
  const allowed = ids.filter((id) => !isProtectedBackupsRoot(id));
  return { allowed, skippedProtected: allowed.length !== ids.length };
}
