import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as FileSystem from 'expo-file-system/legacy';
import NetInfo from '@react-native-community/netinfo';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../App';
import { estimatePhotoPreviewBytes } from '../../modules/beebeeb-crypto';
import { NativeSwitch } from '../components/NativeSwitch';
import { serverSupportsPhotoPreviews, type FileEntry } from '../lib/api';
import { useCrypto } from '../lib/crypto-context';
import { encryptedMetadataPayloadToBytes } from '../lib/encrypted-metadata';
import { loadFileIndex } from '../lib/file-index-loader';
import { formatBytes } from '../lib/format';
import { ensurePhotoPermission } from '../lib/photo-permissions';
import { encodePreviewSample } from '../lib/photo-compare-samples';
import { planApply, turnOffPreviews } from '../lib/photo-preview-apply';
import {
  clearPreviewCache,
  commitPreviewCacheLimit,
  getPreviewCacheLimitBytes,
  previewCacheUsage,
} from '../lib/photo-preview-cache';
import { applyConfirmMessage, previewQuotaExceededMessage, rebuildConfirmMessage, turnOffConfirmMessage } from '../lib/photo-preview-copy';
import {
  onPhotoPreviewRun,
  photoPreviewRunProgress,
  startPhotoPreviewRun,
  stopPhotoPreviewRun,
  type PhotoPreviewRunOutcome,
} from '../lib/photo-preview-runner';
import {
  estimateTotals,
  immediatePreviewEstimate,
  pickSampleAsset,
  pickSampleIds,
  shouldStartEstimate,
  type EstimateEntry,
} from '../lib/photo-preview-estimate';
import {
  mergePreviewScopeMimes,
  partitionPreviewScope,
  remainingPreviewScopeBudget,
} from '../lib/photo-preview-scope';
import {
  previewCompareIdentifier,
  previewPrimaryAction,
  previewStorageAddition,
  previewSupportState,
} from '../lib/photo-preview-screen-state';
import { createPhotoPreviewToggleCoordinator } from '../lib/photo-preview-toggle';
import {
  DEFAULT_PHOTO_PREVIEW_SETTING,
  PREVIEW_SIZE_OPTIONS,
  savePhotoPreviewSetting,
  type PhotoPreviewSetting,
  type PreviewFormat,
  type PreviewPx,
} from '../lib/photo-preview-settings';
import { loadSettingForScreen, mirrorPhotoPreviewSetting, onPhotoPreviewSettingChange } from '../lib/photo-preview-sync';
import {
  PreviewTimeoutError,
  withAbortablePreviewTimeout,
  withPreviewTimeout,
} from '../lib/photo-preview-timeout';
import { recordRuntimeTrace } from '../lib/runtime-trace';
import { useTheme } from '../lib/theme-context';
import { useToast } from '../lib/toast-context';
import { getRemoteToLocalMap } from '../services/BackupDatabase';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type PlanFile = Pick<FileEntry, 'id' | 'has_preview' | 'preview_format' | 'preview_px' | 'preview_bytes' | 'mime_type'>;

const GB = 1024 * 1024 * 1024;
const SAMPLE_COUNT = 3;
const SCREEN_LOAD_TIMEOUT_MS = 8_000;
const METADATA_BATCH_TIMEOUT_MS = 4_000;
const ESTIMATE_SAMPLE_TIMEOUT_MS = 5_000;
const FORMATS: { label: string; value: PreviewFormat }[] = [
  { label: 'HEIC', value: 'heic' },
  { label: 'JPEG', value: 'jpeg' },
];

function sizeLabel(px: PreviewPx): string {
  return PREVIEW_SIZE_OPTIONS.find((o) => o.px === px)?.label ?? `${px}`;
}

function decryptedMime(plaintext: string): string | null {
  try {
    const m = JSON.parse(plaintext) as { mime_type?: unknown };
    return m && typeof m.mime_type === 'string' && m.mime_type.trim() ? m.mime_type.trim() : null;
  } catch {
    return null;
  }
}

export default function PhotoPreviewsScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const accessibilityLayout = fontScale >= 1.3;
  const { showToast } = useToast();
  const { decryptMetadata } = useCrypto();

  const [supported, setSupported] = useState<boolean | null>(null);
  const [setting, setSetting] = useState<PhotoPreviewSetting>(DEFAULT_PHOTO_PREVIEW_SETTING);
  const [settingLoaded, setSettingLoaded] = useState(false);
  const [settingFailed, setSettingFailed] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // Photos on this phone (images only) and the planning inputs.
  const [files, setFiles] = useState<PlanFile[]>([]);
  const [localIds, setLocalIds] = useState<Map<string, string>>(new Map());
  const [scopeLoading, setScopeLoading] = useState(true);
  const [scopeFailed, setScopeFailed] = useState(false);
  const [scopeTick, setScopeTick] = useState<{ n: number; force: boolean }>({ n: 0, force: false });

  // Estimate, one entry per format:size. Results are stored under their own key,
  // so a re-render (photo list re-read after Apply, a setting change) never drops one.
  const [estimates, setEstimates] = useState<Record<string, EstimateEntry>>({});
  const estimatesInFlight = useRef(new Set<string>());
  const [estimateTick, setEstimateTick] = useState(0);

  // Space limit
  const [limitBytes, setLimitBytes] = useState<number | null>(null);
  const [maxLimitBytes, setMaxLimitBytes] = useState(20 * GB);
  const [diskInfo, setDiskInfo] = useState<{ total: number; free: number } | null>(null);
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);

  // Large preview of the newest photo
  const [newestId, setNewestId] = useState<string | null>(null);
  const [sample, setSample] = useState<{ uri: string; bytes: number; localIdentifier: string } | null>(null);
  const [sampleStatus, setSampleStatus] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [sampleTick, setSampleTick] = useState(0);
  const [originalBytes, setOriginalBytes] = useState<number | null>(null);

  // Work in progress. Apply/Rebuild run in the app-level runner: leaving this
  // screen does not stop them; the screen only follows their progress.
  const [applyProgress, setApplyProgress] = useState<{ done: number; total: number } | null>(() => photoPreviewRunProgress());
  const [busy, setBusy] = useState<null | 'off' | 'clear' | 'save'>(null);
  const [togglePending, setTogglePending] = useState(false);
  const toggleCoordinatorRef = useRef(createPhotoPreviewToggleCoordinator());
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  /** Re-read the photos list (counts, plan, button label) after a change. */
  const reloadScope = useCallback((force: boolean) => setScopeTick((t) => ({ n: t.n + 1, force })), []);

  const reportOutcome = useCallback((outcome: PhotoPreviewRunOutcome) => {
    if (outcome.error) {
      showToast({ type: 'error', message: 'Could not finish making previews.' });
    } else if (outcome.stoppedBySettingChange) {
      showToast({ type: 'info', message: 'Stopped because the photo previews setting changed.' });
    } else if (outcome.stoppedByUser) {
      showToast({ type: 'info', message: `Stopped after ${outcome.done.toLocaleString()} previews. Apply again to make the rest.` });
    } else if (outcome.quotaExceeded) {
      showToast({ type: 'info', message: previewQuotaExceededMessage(outcome.done) });
    } else if (outcome.aborted || outcome.stoppedLocked) {
      showToast({ type: 'info', message: 'Stopped. It continues where it left off next time.' });
    } else if (outcome.failed > 0) {
      showToast({ type: 'info', message: `${outcome.done} previews made, ${outcome.failed} could not be made.` });
    } else {
      showToast({ type: 'success', message: `${outcome.done} previews made.` });
    }
  }, [showToast]);

  useEffect(() => onPhotoPreviewRun((event) => {
    if (!mountedRef.current) return;
    if (event.type === 'progress') {
      setApplyProgress({ done: event.progress.done, total: event.progress.total });
      return;
    }
    setApplyProgress(null);
    reportOutcome(event.outcome);
    // The runner already re-read the index from the server when previews were made.
    reloadScope(false);
  }), [reportOutcome, reloadScope]);

  // The setting changed elsewhere (another device, via sync).
  useEffect(() => onPhotoPreviewSettingChange((next) => {
    if (mountedRef.current) setSetting(next);
  }), []);

  const disabled = supported !== true || !settingLoaded || settingFailed;
  const working = applyProgress !== null || busy !== null || togglePending;
  const controlsOff = disabled || working;

  // ── Account setting (retryable) ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setSettingFailed(false);
    setSettingLoaded(false);
    void (async () => {
      try {
        const ok = await withPreviewTimeout(
          serverSupportsPhotoPreviews(),
          SCREEN_LOAD_TIMEOUT_MS,
          'Photo preview support check',
        );
        if (cancelled) return;
        setSupported(ok);
        if (!ok) return;
        const result = await withPreviewTimeout(
          loadSettingForScreen(),
          SCREEN_LOAD_TIMEOUT_MS,
          'Photo preview setting',
        );
        if (cancelled) return;
        if (result.status === 'loaded') {
          setSetting(result.setting);
          setSettingLoaded(true);
          setSettingFailed(false);
        } else {
          setSettingFailed(true);
        }
      } catch {
        if (!cancelled) setSettingFailed(true);
      }
    })();

    return () => { cancelled = true; };
  }, [reloadTick]);

  // ── Initial loads ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [limit, total, free, usage] = await Promise.all([
          getPreviewCacheLimitBytes(),
          FileSystem.getTotalDiskCapacityAsync().catch(() => 0),
          FileSystem.getFreeDiskStorageAsync().catch(() => 0),
          previewCacheUsage().catch(() => ({ files: 0, bytes: 0 })),
        ]);
        if (cancelled) return;
        setLimitBytes(limit);
        setMaxLimitBytes(Math.max(2 * GB, Math.floor(free * 0.5)));
        setDiskInfo({ total, free });
        setCacheBytes(usage.bytes);
      } catch {
        // Fall back to defaults below.
      }
    })();

    void (async () => {
      try {
        const { granted } = await ensurePhotoPermission(MediaLibrary);
        if (cancelled || !granted) return;
        const result = await MediaLibrary.getAssetsAsync({
          first: 20,
          mediaType: MediaLibrary.MediaType.photo,
          sortBy: MediaLibrary.SortBy.creationTime,
        });
        const asset = pickSampleAsset(result.assets);
        if (!asset || cancelled) return;
        setNewestId(asset.id);
        const info = await MediaLibrary.getAssetInfoAsync(asset);
        const fsInfo = await FileSystem.getInfoAsync(info.localUri ?? info.uri);
        if (!cancelled && fsInfo.exists) setOriginalBytes(fsInfo.size ?? null);
      } catch {
        // No photo access or no photos.
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Photos list (first load, and again after Apply, Rebuild or Off) ─────
  useEffect(() => {
    let cancelled = false;
    const scopeStartedAt = Date.now();
    let baseFiles: PlanFile[] | null = null;
    const openedMimes = new Map<string, string>();
    setScopeLoading(true);
    setScopeFailed(false);
    void (async () => {
      try {
        const [loaded, map] = await Promise.all([
          withPreviewTimeout(
            loadFileIndex(scopeTick.force ? { force: true } : undefined),
            SCREEN_LOAD_TIMEOUT_MS,
            'Photo list',
          ),
          withPreviewTimeout(getRemoteToLocalMap(), SCREEN_LOAD_TIMEOUT_MS, 'Photos on this iPhone'),
        ]);
        if (cancelled) return;
        const partition = partitionPreviewScope(loaded.files ?? [], map);
        setLocalIds(map);
        baseFiles = partition.files.map(({ entry, mime }) => ({
          id: entry.id,
          has_preview: entry.has_preview,
          preview_format: entry.preview_format,
          preview_px: entry.preview_px,
          preview_bytes: entry.preview_bytes,
          mime_type: mime,
        }));
        setFiles(baseFiles);

        // Production does not expose plaintext MIME. Open only ambiguous rows
        // whose originals are local, in small yielding batches. The first
        // batch paints promptly; later results are accumulated and merged in
        // one pass so a large vault cannot trigger an O(N²) render loop.
        for (let offset = 0; offset < partition.localEncrypted.length; offset += 8) {
          const batch = partition.localEncrypted.slice(offset, offset + 8);
          const batchBudget = remainingPreviewScopeBudget(
            scopeStartedAt,
            Date.now(),
            SCREEN_LOAD_TIMEOUT_MS,
            METADATA_BATCH_TIMEOUT_MS,
          );
          if (batchBudget === 0) {
            throw new PreviewTimeoutError('Photo metadata', SCREEN_LOAD_TIMEOUT_MS);
          }
          const opened = await withPreviewTimeout(Promise.all(batch.map(async (entry) => {
            let mime: string | null = null;
            const raw = entry.name_encrypted ?? '';
            try {
              const payload = encryptedMetadataPayloadToBytes(raw);
              if (payload) {
                mime = decryptedMime(await decryptMetadata(entry.id, payload.nonce, payload.ciphertext));
              }
            } catch {
              // One unreadable metadata row does not block the rest of the scope.
            }
            return { id: entry.id, mime };
          })), batchBudget, 'Photo metadata');
          if (cancelled) return;
          for (const item of opened) {
            if (item.mime) openedMimes.set(item.id, item.mime);
          }
          if (offset === 0 && openedMimes.size > 0 && baseFiles) {
            setFiles(mergePreviewScopeMimes(baseFiles, openedMimes));
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (cancelled) return;
        }
      } catch {
        if (!cancelled) setScopeFailed(true);
      } finally {
        if (!cancelled) {
          if (baseFiles && openedMimes.size > 0) {
            setFiles(mergePreviewScopeMimes(baseFiles, openedMimes));
          }
          setScopeLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeTick]);

  // ── Derived plan ─────────────────────────────────────────────────────────
  const imageIdsOnPhone = useMemo(
    () => files
      .filter((f) => f.mime_type?.toLowerCase().startsWith('image/') && localIds.get(f.id))
      .map((f) => localIds.get(f.id) as string),
    [files, localIds],
  );
  const photoCount = imageIdsOnPhone.length;
  const fallbackPreviewId = imageIdsOnPhone[0] ?? null;
  const plan = useMemo(() => planApply(files, setting, localIds), [files, setting, localIds]);

  // ── Estimate and large preview, per format/size ─────────────────────────
  const key = `${setting.format}:${setting.px}`;
  useEffect(() => {
    if (supported !== true || imageIdsOnPhone.length === 0) return;
    const runKey = key;
    if (shouldStartEstimate(estimates[runKey], estimatesInFlight.current.has(runKey))) {
      estimatesInFlight.current.add(runKey);
      setEstimates((prev) => ({ ...prev, [runKey]: { status: 'loading' } }));
      const ids = pickSampleIds(imageIdsOnPhone, SAMPLE_COUNT);
      void (async () => {
        let totalBytes = 0;
        let sampled = 0;
        for (const id of ids) {
          try {
            const result = await withPreviewTimeout(
              estimatePhotoPreviewBytes([id], setting.format, setting.px),
              ESTIMATE_SAMPLE_TIMEOUT_MS,
              'Preview size sample',
            );
            if (result.sampled > 0 && result.averageBytes > 0) {
              totalBytes += result.averageBytes;
              sampled += result.sampled;
              if (mountedRef.current) {
                const entry: EstimateEntry = { status: 'done', avgBytes: Math.round(totalBytes / sampled), sampled };
                setEstimates((prev) => ({ ...prev, [runKey]: entry }));
              }
            }
          } catch (error) {
            // A timed-out PhotoKit/iCloud request may still finish natively. Do
            // not start more requests behind it; the local estimate stays live.
            if (error instanceof PreviewTimeoutError) break;
          }
        }
        estimatesInFlight.current.delete(runKey);
        if (mountedRef.current && sampled === 0) {
          setEstimates((prev) => ({ ...prev, [runKey]: { status: 'failed' } }));
        }
      })();
    }
  // `estimates` is read, not a trigger: a landed result must not start another run.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, supported, imageIdsOnPhone, estimateTick]);

  useEffect(() => {
    const forPreview = newestId ?? fallbackPreviewId;
    if (supported !== true || !forPreview) {
      setSample(null);
      setSampleStatus('idle');
      return;
    }
    let cancelled = false;
    setSample(null);
    setSampleStatus('loading');
    void encodePreviewSample(forPreview, setting.format, setting.px)
      .then((r) => {
        if (cancelled) return;
        setSample({
          uri: r.path.startsWith('file://') ? r.path : `file://${r.path}`,
          bytes: r.bytes,
          localIdentifier: forPreview,
        });
        setSampleStatus('idle');
      })
      .catch(() => {
        if (!cancelled) {
          setSample(null);
          setSampleStatus('failed');
        }
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, supported, newestId, fallbackPreviewId, sampleTick]);

  const immediateEstimate = useMemo(
    () => immediatePreviewEstimate(setting.format, setting.px, files),
    [setting.format, setting.px, files],
  );
  const measuredEstimate = estimates[key]?.status === 'done' ? estimates[key] : null;
  const avgBytes = photoCount > 0 ? measuredEstimate?.avgBytes ?? immediateEstimate.avgBytes : null;
  const effectiveLimit = Math.min(limitBytes ?? 20 * GB, maxLimitBytes);
  const totals = avgBytes != null ? estimateTotals(avgBytes, photoCount, effectiveLimit) : null;
  const storageAdd = previewStorageAddition({
    scopeLoading,
    scopeFailed,
    toCreate: plan.toCreate.length,
    avgBytes,
  });
  const compareIdentifier = previewCompareIdentifier({
    newestId,
    fallbackId: fallbackPreviewId,
    sampledId: sample?.localIdentifier ?? null,
  });
  const supportState = previewSupportState({ supported, loadFailed: settingFailed });

  // ── Actions ──────────────────────────────────────────────────────────────
  const persist = useCallback(async (next: PhotoPreviewSetting, prev: PhotoPreviewSetting): Promise<boolean> => {
    setSetting(next);
    try {
      await withAbortablePreviewTimeout(
        signal => savePhotoPreviewSetting(next, signal),
        SCREEN_LOAD_TIMEOUT_MS,
        'Saving photo preview setting',
      );
      mirrorPhotoPreviewSetting(next);
      return true;
    } catch {
      setSetting(prev);
      showToast({ type: 'error', message: 'Could not save the photo previews setting.' });
      return false;
    }
  }, [showToast]);

  const toggleEnabled = useCallback((on: boolean) => {
    const prev = setting;
    const next = { ...prev, enabled: on };
    const requestedAt = Date.now();
    recordRuntimeTrace('photo_previews.toggle.request', { enabled: on });
    toggleCoordinatorRef.current.request({
      nextEnabled: on,
      onPending: () => {
        if (mountedRef.current) setTogglePending(true);
      },
      onSettled: () => {
        recordRuntimeTrace('photo_previews.toggle.settled', {
          enabled: on,
          elapsedMs: Date.now() - requestedAt,
        });
        if (mountedRef.current) setTogglePending(false);
      },
      onError: () => {
        showToast({ type: 'error', message: 'Could not change the photo previews setting.' });
      },
      confirmTurnOff: ({ confirm, cancel }) => {
        recordRuntimeTrace('photo_previews.toggle.confirmation_shown', {
          elapsedMs: Date.now() - requestedAt,
        });
        Alert.alert(
          'Turn off photo previews?',
          turnOffConfirmMessage(null),
          [
            {
              text: 'Cancel',
              style: 'cancel',
              onPress: () => {
                recordRuntimeTrace('photo_previews.toggle.cancelled', {
                  elapsedMs: Date.now() - requestedAt,
                });
                cancel();
              },
            },
            {
              text: 'Turn off',
              style: 'destructive',
              onPress: () => {
                recordRuntimeTrace('photo_previews.toggle.confirmed', {
                  elapsedMs: Date.now() - requestedAt,
                });
                confirm();
              },
            },
          ],
          { cancelable: true, onDismiss: cancel },
        );
      },
      setOptimistic: () => {
        setSetting(next);
        recordRuntimeTrace('photo_previews.toggle.optimistic', {
          enabled: on,
          elapsedMs: Date.now() - requestedAt,
        });
      },
      run: async () => {
        if (!(await persist(next, prev)) || on) return;
        // A run still going would upload new previews after the delete.
        stopPhotoPreviewRun();
        try {
          const removed = await withAbortablePreviewTimeout(
            signal => turnOffPreviews(signal),
            SCREEN_LOAD_TIMEOUT_MS,
            'Removing stored photo previews',
          );
          if (mountedRef.current) setCacheBytes(0);
          showToast({
            type: 'success',
            message: removed > 0
              ? `${removed.toLocaleString()} previews removed.`
              : 'Photo previews are off. There were no stored previews to remove.',
          });
        } catch {
          showToast({
            type: 'error',
            message: 'Could not remove the stored previews. Turn previews on and off again to retry.',
          });
        } finally {
          if (mountedRef.current) reloadScope(true);
        }
      },
    });
  }, [setting, persist, showToast, reloadScope]);

  const changeFormat = (format: PreviewFormat) => {
    if (format !== setting.format) void persist({ ...setting, format }, setting);
  };
  const changeSize = (px: PreviewPx) => {
    if (px !== setting.px) void persist({ ...setting, px }, setting);
  };

  const saveCurrentSetting = useCallback(() => {
    setBusy('save');
    void persist({ ...setting }, setting)
      .then((saved) => {
        if (saved) showToast({ type: 'success', message: 'Photo preview setting saved.' });
      })
      .finally(() => { if (mountedRef.current) setBusy(null); });
  }, [persist, setting, showToast]);

  const runPlan = useCallback((kind: 'apply' | 'rebuild') => {
    const started = kind === 'apply'
      ? startPhotoPreviewRun({ kind: 'apply', plan, setting, localIds, discardSaved: true })
      : startPhotoPreviewRun({ kind: 'rebuild', files, setting, localIds });
    if (!started) {
      showToast({ type: 'info', message: 'Previews are already being made.' });
      return;
    }
    setApplyProgress({ done: 0, total: kind === 'apply' ? plan.toCreate.length : planApply(files, setting, localIds, { force: true }).toCreate.length });
  }, [plan, files, setting, localIds, showToast]);

  const onWifiNow = async (): Promise<boolean> => {
    const net = await withPreviewTimeout(NetInfo.fetch(), 2_000, 'Network status').catch(() => null);
    return net?.type === 'wifi';
  };

  const confirmApply = async () => {
    const n = plan.toCreate.length;
    const onWifi = await onWifiNow();
    Alert.alert(
      `Apply to ${n.toLocaleString()} photos`,
      applyConfirmMessage({
        sizeLabel: sizeLabel(setting.px),
        format: setting.format,
        storageBytes: storageAdd,
        onWifi,
        skipped: plan.skippedNotOnPhone,
      }),
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Apply', onPress: () => runPlan('apply') },
      ],
    );
  };

  const confirmRebuild = () => {
    const rebuild = planApply(files, setting, localIds, { force: true });
    Alert.alert(
      'Rebuild previews',
      rebuildConfirmMessage({
        sizeLabel: sizeLabel(setting.px),
        format: setting.format,
        storageBytes: avgBytes != null ? Math.round(avgBytes * rebuild.toCreate.length) : null,
        onWifi: false,
        skipped: rebuild.skippedNotOnPhone,
      }),
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Rebuild', style: 'destructive', onPress: () => runPlan('rebuild') },
      ],
    );
  };

  /** Space limit: stored clamped to the slider range; lowering it trims right away. */
  const commitLimit = (value: number) => {
    void commitPreviewCacheLimit(value, sliderMin, sliderMax)
      .then(({ limit, usageBytes }) => {
        if (!mountedRef.current) return;
        setLimitBytes(limit);
        setCacheBytes(usageBytes);
      })
      .catch(() => {});
  };

  const confirmClear = () => {
    setBusy('clear');
    void clearPreviewCache()
      .then(() => {
        setCacheBytes(0);
        showToast({ type: 'success', message: 'Preview cache cleared. Your stored previews are untouched.' });
      })
      .catch(() => showToast({ type: 'error', message: 'Could not clear the preview cache.' }))
      .finally(() => { if (mountedRef.current) setBusy(null); });
  };

  // ── Render ───────────────────────────────────────────────────────────────
  const dim = controlsOff ? 0.45 : 1;
  const selectedBg = c.amber;

  function Segmented<T extends string | number>({
    options, value, onChange, label,
  }: { options: { label: string; value: T }[]; value: T; onChange: (v: T) => void; label: string }) {
    return (
      <View
        style={[
          styles.segment,
          accessibilityLayout && styles.segmentAccessibility,
          { backgroundColor: c.paper, borderColor: c.line, opacity: dim },
        ]}
      >
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <TouchableOpacity
              key={String(o.value)}
              disabled={controlsOff}
              onPress={() => onChange(o.value)}
              style={[styles.segmentItem, { backgroundColor: selected ? selectedBg : 'transparent' }]}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: controlsOff }}
              accessibilityLabel={`${label} ${o.label}`}
            >
              <Text style={[styles.segmentText, { color: selected ? '#16110a' : c.ink2 }]}>{o.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  }

  const sliderMin = 1 * GB;
  const sliderMax = Math.max(maxLimitBytes, sliderMin + GB);
  const applyCount = plan.toCreate.length;
  const primaryAction = previewPrimaryAction({
    controlsReady: !disabled,
    working,
    enabled: setting.enabled,
    scopeReady: !scopeLoading,
    applyCount,
  });
  const primaryDisabled = primaryAction === 'disabled';
  const primaryVisible = primaryAction !== 'none' || applyProgress !== null;
  const estimateEntry = estimates[key];
  const estimateCaption = photoCount === 0
    ? scopeLoading
      ? 'Estimate unavailable until the photo count is ready.'
      : scopeFailed
        ? 'Estimate unavailable because the photo list could not be loaded.'
        : 'No photos from this iPhone are backed up yet.'
    : measuredEstimate
      ? `Average ${formatBytes(measuredEstimate.avgBytes)} per photo, measured on ${measuredEstimate.sampled} of your photos`
      : immediateEstimate.basis === 'known-previews'
        ? `Estimated locally from ${immediateEstimate.sampled} matching stored previews${estimateEntry?.status === 'loading' ? ' · refining with a photo sample…' : ''}`
        : `Estimated locally for this format and size${estimateEntry?.status === 'loading' ? ' · refining with a photo sample…' : ''}`;

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: c.line }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconButton} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.ink }]}>Photo previews</Text>
        <View style={styles.iconButton} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
      >
        {supportState === 'unsupported' ? (
          <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
            <Text style={[styles.rowTitle, { color: c.ink }]}>Photo previews need a server update</Text>
            <Text style={[styles.caption, { color: c.ink3 }]}>
              Your photos keep working as they do today. This option appears here once the update reaches your account.
            </Text>
          </View>
        ) : null}

        {supportState === 'retry' ? (
          <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
            <Text style={[styles.rowTitle, { color: c.ink }]}>Couldn't load your preview setting.</Text>
            <TouchableOpacity
              onPress={() => setReloadTick((n) => n + 1)}
              accessibilityRole="button"
              accessibilityLabel="Try again"
              style={styles.linkButton}
            >
              <Text style={[styles.linkText, { color: c.amberDeep }]}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line, marginTop: supported === false || settingFailed ? 12 : 0 }]}>
          <View style={[styles.row, accessibilityLayout && styles.rowAccessibility]}>
            <Text style={[styles.rowTitle, { color: c.ink, flex: 1 }]}>Photo previews</Text>
            {supportState === 'loading' || (supported && !settingLoaded && !settingFailed) ? (
              <ActivityIndicator color={c.amber} />
            ) : (
              <NativeSwitch
                colors={c}
                value={setting.enabled}
                disabled={controlsOff}
                onValueChange={(v) => { void toggleEnabled(v); }}
                accessibilityLabel="Photo previews"
              />
            )}
          </View>
        </View>

        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Format</Text>
        <Segmented options={FORMATS} value={setting.format} onChange={changeFormat} label="Format" />
        <Text style={[styles.hint, { color: c.ink3 }]}>HEIC is about half the size at the same quality. JPEG opens anywhere.</Text>

        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Size</Text>
        <Segmented
          options={PREVIEW_SIZE_OPTIONS.map((o) => ({ label: o.label, value: o.px }))}
          value={setting.px}
          onChange={changeSize}
          label="Size"
        />

        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Preview — tap to compare</Text>
        <TouchableOpacity
          disabled={controlsOff || !compareIdentifier}
          onPress={() => compareIdentifier && navigation.navigate('PhotoPreviewCompare', { localIdentifier: compareIdentifier })}
          style={[styles.hero, { opacity: dim }]}
          accessibilityRole="button"
          accessibilityLabel="Compare full screen"
        >
          {/* contain, not cover: the whole photo shows; a cover crop of a tall photo (a screenshot) read as broken UI */}
          {sample ? <Image source={{ uri: sample.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" /> : null}
          {!sample && sampleStatus === 'loading' ? (
            <View style={styles.heroStatus} pointerEvents="none">
              <ActivityIndicator color="#fff" />
              <Text style={styles.heroStatusText}>Loading preview…</Text>
            </View>
          ) : null}
          {!sample && sampleStatus === 'failed' ? (
            <View style={styles.heroStatus} pointerEvents="none">
              <Ionicons name="image-outline" size={24} color="#fff" />
              <Text style={styles.heroStatusText}>Preview unavailable</Text>
            </View>
          ) : null}
          <View style={styles.heroTag}>
            <Ionicons name="expand-outline" size={12} color="#fff" />
            <Text style={styles.heroTagText}>Compare full screen</Text>
          </View>
        </TouchableOpacity>
        {sample ? (
          <Text style={[styles.hint, { color: c.ink3 }]}>
            {`Your newest photo · this setting ${formatBytes(sample.bytes)}${originalBytes != null ? ` · original ${formatBytes(originalBytes)}` : ''}`}
          </Text>
        ) : sampleStatus === 'failed' ? (
          <TouchableOpacity
            onPress={() => setSampleTick((n) => n + 1)}
            style={styles.linkButton}
            accessibilityRole="button"
            accessibilityLabel="Try loading the preview again"
          >
            <Text style={[styles.linkText, { color: c.amberDeep }]}>Try preview again</Text>
          </TouchableOpacity>
        ) : null}

        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>On this iPhone</Text>
        <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
          <Text style={[styles.body, { color: c.ink }]}>
            {`${scopeLoading ? 'Found' : 'All'} ${photoCount.toLocaleString()} photos at `}
            <Text style={styles.bold}>{`${sizeLabel(setting.px)} ${setting.format.toUpperCase()}`}</Text>
          </Text>
          <Text style={[styles.big, { color: c.ink }]}>
            {totals ? `≈ ${formatBytes(totals.totalBytes)}` : '—'}
          </Text>
          <Text style={[styles.caption, { color: c.ink3 }]}>{estimateCaption}</Text>
          {scopeLoading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={c.amber} size="small" />
              <Text style={[styles.caption, { color: c.ink3 }]}>Finding photos on this iPhone…</Text>
            </View>
          ) : null}
          {scopeFailed ? (
            <TouchableOpacity
              onPress={() => reloadScope(true)}
              style={styles.linkButton}
              accessibilityRole="button"
              accessibilityLabel="Try loading photos again"
            >
              <Text style={[styles.linkText, { color: c.amberDeep }]}>Try loading photos again</Text>
            </TouchableOpacity>
          ) : null}
          {photoCount > 0 && estimateEntry?.status === 'failed' ? (
            <TouchableOpacity
              onPress={() => setEstimateTick((n) => n + 1)}
              style={styles.linkButton}
              accessibilityRole="button"
              accessibilityLabel="Try measuring a photo again"
            >
              <Text style={[styles.linkText, { color: c.amberDeep }]}>Try photo sample again</Text>
            </TouchableOpacity>
          ) : null}

          <Slider
            style={styles.slider}
            minimumValue={sliderMin}
            maximumValue={sliderMax}
            value={Math.min(Math.max(effectiveLimit, sliderMin), sliderMax)}
            disabled={controlsOff}
            onValueChange={(v) => setLimitBytes(Math.round(v))}
            onSlidingComplete={commitLimit}
            minimumTrackTintColor={c.amber}
            maximumTrackTintColor={c.line2}
            thumbTintColor={c.amber}
            accessibilityLabel="Space for previews"
          />
          <View style={[styles.sliderEnds, accessibilityLayout && styles.sliderEndsAccessibility]}>
            <Text style={[styles.caption, { color: c.ink3 }]}>1 GB</Text>
            <Text style={[styles.caption, { color: c.ink3 }]}>50% of free space</Text>
          </View>
          <Text style={[styles.body, { color: c.ink }]}>
            {'Space for previews: '}
            <Text style={styles.bold}>{formatBytes(effectiveLimit)}</Text>
            {totals ? (
              <Text style={{ color: totals.fitsAll ? c.green : c.amberDeep }}>
                {totals.fitsAll
                  ? ' · all photos fit'
                  : ` · ${totals.fitCount.toLocaleString()} of ${photoCount.toLocaleString()} fit`}
              </Text>
            ) : null}
          </Text>
          {diskInfo && diskInfo.total > 0 ? (
            <Text style={[styles.caption, { color: c.ink3 }]}>
              {`${formatBytes(diskInfo.total)} phone · ${formatBytes(diskInfo.free)} free`}
              {cacheBytes != null ? ` · ${formatBytes(cacheBytes)} used by previews` : ''}
            </Text>
          ) : null}
        </View>

        <Text style={[styles.body, { color: c.ink2, marginTop: 14 }]}>
          {'In your Beebeeb storage: '}
          <Text style={[styles.bold, { color: c.ink }]}>
            {storageAdd != null ? `+ ${formatBytes(storageAdd)}` : '—'}
          </Text>
        </Text>

        {primaryVisible ? (
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: primaryDisabled ? c.line2 : c.amber }]}
            disabled={primaryDisabled}
            onPress={() => {
              if (primaryAction === 'apply') void confirmApply();
              else if (primaryAction === 'save') saveCurrentSetting();
            }}
            accessibilityRole="button"
            accessibilityLabel={primaryAction === 'apply' ? `Apply to ${applyCount} photos` : 'Save photo preview setting'}
          >
            {applyProgress ? (
              <Text style={styles.primaryButtonText}>
                {`Making previews… ${applyProgress.done.toLocaleString()} of ${applyProgress.total.toLocaleString()}`}
              </Text>
            ) : (
              <Text style={styles.primaryButtonText}>
                {primaryAction === 'apply' ? `Apply to ${applyCount.toLocaleString()} photos` : 'Save setting'}
              </Text>
            )}
          </TouchableOpacity>
        ) : null}
        {applyProgress ? (
          <TouchableOpacity
            onPress={stopPhotoPreviewRun}
            style={styles.linkButton}
            accessibilityRole="button"
            accessibilityLabel="Stop making previews"
            testID="photo-previews-stop"
          >
            <Text style={[styles.linkText, { color: c.ink2 }]}>Stop</Text>
          </TouchableOpacity>
        ) : null}
        {plan.skippedNotOnPhone > 0 ? (
          <Text style={[styles.hint, { color: c.ink3 }]}>
            {`${plan.skippedNotOnPhone.toLocaleString()} photos are not on this iPhone. They get a preview the first time you open them here.`}
          </Text>
        ) : null}

        <TouchableOpacity
          style={[styles.secondaryButton, { borderColor: c.line, opacity: dim }]}
          disabled={controlsOff}
          onPress={confirmClear}
          accessibilityRole="button"
          accessibilityLabel="Clear preview cache"
        >
          <Text style={[styles.secondaryText, { color: c.ink }]}>Clear preview cache</Text>
          <Text style={[styles.caption, { color: c.ink3 }]}>Removes previews from this iPhone only. Your stored previews stay.</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.secondaryButton, { borderColor: c.line, opacity: dim }]}
          disabled={controlsOff || !setting.enabled}
          onPress={confirmRebuild}
          accessibilityRole="button"
          accessibilityLabel="Rebuild previews"
        >
          <Text style={[styles.secondaryText, { color: c.red }]}>Rebuild previews</Text>
          <Text style={[styles.caption, { color: c.ink3 }]}>Re-creates every preview from your originals.</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
  },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  scroll: { flex: 1 },
  sectionTitle: { fontSize: 12, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginTop: 18, marginBottom: 8 },
  card: { borderWidth: 1, borderRadius: 12, overflow: 'hidden', padding: 12, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowAccessibility: { alignItems: 'flex-start' },
  rowTitle: { fontSize: 15, fontWeight: '800' },
  body: { fontSize: 14, lineHeight: 20 },
  bold: { fontWeight: '800' },
  big: { fontSize: 26, fontWeight: '900' },
  caption: { fontSize: 12, lineHeight: 17 },
  hint: { fontSize: 12, lineHeight: 17, marginTop: 6 },
  segment: { flexDirection: 'row', borderRadius: 10, overflow: 'hidden', borderWidth: 1 },
  segmentAccessibility: { flexDirection: 'column' },
  segmentItem: { flex: 1, paddingHorizontal: 8, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontSize: 13, fontWeight: '800', textAlign: 'center' },
  hero: { height: 180, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000' },
  heroStatus: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 8 },
  heroStatusText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  heroTag: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    maxWidth: '90%',
  },
  heroTagText: { flexShrink: 1, color: '#fff', fontSize: 11, fontWeight: '700' },
  slider: { width: '100%', height: 36, marginTop: 4 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sliderEnds: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -6 },
  sliderEndsAccessibility: { alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 },
  primaryButton: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 14, paddingHorizontal: 12, paddingVertical: 12 },
  primaryButtonText: { color: '#16110a', fontSize: 15, fontWeight: '900', textAlign: 'center' },
  linkButton: { alignSelf: 'center', paddingVertical: 10 },
  linkText: { fontSize: 14, fontWeight: '700' },
  secondaryButton: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 2, marginTop: 12 },
  secondaryText: { fontSize: 15, fontWeight: '800' },
});
