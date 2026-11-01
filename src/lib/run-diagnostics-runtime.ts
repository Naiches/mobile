/**
 * Wires the run recorder (run-diagnostics.ts) to the real app: AsyncStorage for the record, the
 * native bridge for the footprint and crash facts, and the caches that can be rebuilt.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { consumePreviousRunNative, getBackupProgress, memoryFootprintMbNative } from '../../modules/beebeeb-crypto';
import { previewActivity } from './native-decrypt';
import { trimPhotoMemoryCache } from './photo-cache';
import { recordRuntimeTrace } from './runtime-trace';
import {
  RUN_HISTORY_STORAGE_KEY,
  createRunRecorder,
  formatRunHistoryLines,
  type RunRecord,
} from './run-diagnostics';
import { trimThumbMemoryCache } from './thumbnail';

let latestBackupContext: Record<string, unknown> = {};

function refreshBackupContext(): void {
  getBackupProgress()
    .then((progress) => {
      latestBackupContext = {
        backupState: typeof progress.state === 'string' ? progress.state : undefined,
        waitingToEncrypt: progress.waitingToEncrypt ?? 0,
        readyToUpload: progress.encryptedPendingUpload ?? 0,
        uploading: progress.uploading ?? progress.inProgress ?? 0,
        failed: progress.failed ?? 0,
      };
    })
    .catch(() => {});
}

/** Release what can be rebuilt. Counts only go to the trace. */
export function trimRebuildableMemory(reason: 'memory_warning'): void {
  const before = memoryFootprintMbNative();
  const photos = trimPhotoMemoryCache();
  const thumbnails = trimThumbMemoryCache();
  recordRuntimeTrace('app.memory_trim', {
    reason,
    photoEntries: photos,
    thumbnailEntries: thumbnails,
    footprintBeforeMb: before,
    footprintAfterMb: memoryFootprintMbNative(),
  });
}

const recorder = createRunRecorder({
  storage: {
    get: () => AsyncStorage.getItem(RUN_HISTORY_STORAGE_KEY),
    set: (value) => AsyncStorage.setItem(RUN_HISTORY_STORAGE_KEY, value),
  },
  native: {
    consumePreviousRun: consumePreviousRunNative,
    memoryFootprintMb: memoryFootprintMbNative,
  },
  context: () => ({ ...previewActivity(), ...latestBackupContext }),
  trim: trimRebuildableMemory,
  now: () => Date.now(),
});

let started = false;

/** Close the previous run into the history and start watching this one. Safe to call twice. */
export function startRunDiagnostics(): void {
  if (started) return;
  started = true;
  void recorder.begin().catch(() => {});
  refreshBackupContext();
  AppState.addEventListener('change', (next) => {
    // `inactive` comes just before `background`, so the snapshot taken on `background` is fresh.
    if (next === 'active' || next === 'inactive') refreshBackupContext();
    void recorder.onAppState(next).catch(() => {});
  });
  AppState.addEventListener('memoryWarning', () => {
    void recorder.onMemoryWarning().catch(() => {});
  });
}

/** The recorded runs, newest first, as lines for the exported log. */
export async function getRunHistoryLines(): Promise<string[]> {
  let history: RunRecord[] = recorder.history();
  if (history.length === 0) {
    try {
      const raw = await AsyncStorage.getItem(RUN_HISTORY_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as { history?: RunRecord[] }) : null;
      if (Array.isArray(parsed?.history)) history = parsed.history;
    } catch {
      // Show "nothing recorded" rather than failing the export.
    }
  }
  return formatRunHistoryLines(history);
}
