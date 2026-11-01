import * as SecureStore from 'expo-secure-store';
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type { UploadActivityState } from '../components/UploadActivityCard';
import { createUploadGate, type UploadGate } from './upload-gate';
import type { FilesAction } from './folder-navigation';
import { useSearchIndex, type UseSearchIndex } from './use-search-index';

export interface PinnedFolder {
  id: string;
  name: string;
}

interface FilesSharedState extends UseSearchIndex {
  pinnedFolders: PinnedFolder[];
  setPinnedFolders: Dispatch<SetStateAction<PinnedFolder[]>>;
  upload: UploadActivityState | null;
  setUpload: Dispatch<SetStateAction<UploadActivityState | null>>;
  uploadGateRef: MutableRefObject<UploadGate | null>;
  tabAction: FilesAction | undefined;
  tabFolderId: string | null | undefined;
  clearTabAction: () => void;
}

const FilesSharedContext = createContext<FilesSharedState | null>(null);
const FilesTabBarVisibilityContext = createContext<((hidden: boolean) => void) | null>(null);

export function FilesTabBarVisibilityProvider({
  children,
  setHidden,
}: {
  children: ReactNode;
  setHidden: (hidden: boolean) => void;
}) {
  return (
    <FilesTabBarVisibilityContext.Provider value={setHidden}>
      {children}
    </FilesTabBarVisibilityContext.Provider>
  );
}

export function useFilesTabBarVisibility(): (hidden: boolean) => void {
  const value = useContext(FilesTabBarVisibilityContext);
  if (!value) throw new Error('useFilesTabBarVisibility must be used inside FilesTabBarVisibilityProvider');
  return value;
}

export function FilesSharedProvider({
  children,
  tabAction,
  tabFolderId,
  clearTabAction,
}: {
  children: ReactNode;
  tabAction: FilesAction | undefined;
  tabFolderId: string | null | undefined;
  clearTabAction: () => void;
}) {
  const searchIndex = useSearchIndex();
  const [pinnedFolders, setPinnedFolders] = useState<PinnedFolder[]>([]);
  const [pinsLoaded, setPinsLoaded] = useState(false);
  const [upload, setUpload] = useState<UploadActivityState | null>(null);
  const uploadGateRef = useRef<UploadGate | null>(null);
  if (uploadGateRef.current === null) uploadGateRef.current = createUploadGate();

  useEffect(() => {
    let cancelled = false;
    SecureStore.getItemAsync('beebeeb_pinned_folders')
      .then((raw) => {
        if (cancelled || !raw) return;
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) setPinnedFolders(parsed as PinnedFolder[]);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setPinsLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!pinsLoaded) return;
    SecureStore.setItemAsync('beebeeb_pinned_folders', JSON.stringify(pinnedFolders)).catch(() => {});
  }, [pinnedFolders, pinsLoaded]);

  const value = useMemo<FilesSharedState>(() => ({
    ...searchIndex,
    pinnedFolders,
    setPinnedFolders,
    upload,
    setUpload,
    uploadGateRef,
    tabAction,
    tabFolderId,
    clearTabAction,
  }), [searchIndex, pinnedFolders, upload, tabAction, tabFolderId, clearTabAction]);

  return <FilesSharedContext.Provider value={value}>{children}</FilesSharedContext.Provider>;
}

export function useFilesSharedState(): FilesSharedState {
  const value = useContext(FilesSharedContext);
  if (!value) throw new Error('useFilesSharedState must be used inside FilesSharedProvider');
  return value;
}
