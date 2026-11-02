import { useSyncExternalStore } from 'react';
import { getProtectedBackupsRootId, subscribeProtectedBackupsRoot } from './protected-folders';

/** The id of the protected root Backups folder (null until known); re-renders when it changes. */
export function useProtectedBackupsRootId(): string | null {
  return useSyncExternalStore(subscribeProtectedBackupsRoot, getProtectedBackupsRootId, getProtectedBackupsRootId);
}
