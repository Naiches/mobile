import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  RefreshControl,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../App';
import { BeebeebThumbnails, type QueueStats } from '../../modules/beebeeb-crypto';
import { useTheme } from '../lib/theme-context';
import { loadFileIndex } from '../lib/file-index-loader';
import { formatBytes } from '../lib/format';
import { useToast } from '../lib/toast-context';
import {
  createCacheUsageController,
  type CacheKind,
  type CacheUsage,
  type CacheUsageController,
} from '../lib/cache-usage';
import { realCacheFs, realCacheInUse, realCacheReset } from '../lib/cache-usage-runtime';
import {
  estimatePerformanceStorage,
  getPerformanceStorageSettings,
  setPerformanceStorageSettings,
  PROFILE_LABELS,
  type PerformanceStorageProfile,
} from '../lib/performance-storage-settings';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const PROFILES: PerformanceStorageProfile[] = ['light', 'balanced', 'smooth'];

const CACHE_ROWS: { kind: CacheKind; label: string; hint: string; done: string }[] = [
  { kind: 'thumbnails', label: 'Thumbnails', hint: 'Small previews in your file lists.', done: 'Thumbnails cleared' },
  { kind: 'previews', label: 'Photo previews', hint: 'Larger photos kept for opening quickly.', done: 'Photo previews cleared' },
  { kind: 'offline', label: 'Offline files', hint: 'Files you kept available offline.', done: 'Offline files cleared' },
  { kind: 'temporary', label: 'Temporary files', hint: 'Copies made while opening or sharing.', done: 'Temporary files cleared' },
];

function profileCopy(profile: PerformanceStorageProfile): string {
  if (profile === 'light') return 'Loads remote thumbnails only when they scroll into view.';
  if (profile === 'smooth') return 'Prefetches normal thumbnails and opens photos with a larger preview thumbnail.';
  return 'Prefetches normal thumbnails around the viewport for smoother scrolling.';
}

export default function AdvancedSettingsScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const accessibilityLayout = fontScale >= 1.3;
  const [profile, setProfile] = useState<PerformanceStorageProfile>('balanced');
  const [fileCount, setFileCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [usage, setUsage] = useState<CacheUsage | null>(null);
  const [clearing, setClearing] = useState<CacheKind | null>(null);
  const { showToast } = useToast();
  const cacheRef = useRef<CacheUsageController | null>(null);

  const estimate = useMemo(() => estimatePerformanceStorage(fileCount, profile), [fileCount, profile]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [perf, stats] = await Promise.all([
        getPerformanceStorageSettings(),
        Platform.OS === 'ios' ? BeebeebThumbnails.getQueueStats().catch(() => null) : Promise.resolve(null),
      ]);
      void cacheRef.current?.refresh();
      setProfile(perf.profile);
      setQueueStats(stats);
      // Fetch file count separately — non-blocking.
      // Task 1959: through the coalescing loader, not a fresh /files/index walk per mount.
      loadFileIndex().then(({ files }) => {
        setFileCount((files ?? []).filter((f) => !f.is_folder && !f.is_uploading).length);
      }).catch(() => {});
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (Platform.OS !== 'ios') return;
      BeebeebThumbnails.getQueueStats().then(setQueueStats).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Real usage on this iPhone: measured when the screen opens, after each Clear,
  // and every few seconds while it stays open.
  useEffect(() => {
    const controller = createCacheUsageController({
      fs: realCacheFs,
      reset: realCacheReset,
      inUse: realCacheInUse,
      onChange: setUsage,
      isActive: () => AppState.currentState === 'active',
    });
    cacheRef.current = controller;
    controller.start();
    void controller.refresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void controller.refresh();
    });
    return () => {
      sub.remove();
      controller.stop();
      cacheRef.current = null;
    };
  }, []);

  const runClear = useCallback(async (row: (typeof CACHE_ROWS)[number]) => {
    const controller = cacheRef.current;
    if (!controller) return;
    setClearing(row.kind);
    try {
      await controller.clear(row.kind);
      showToast({ type: 'success', message: row.done });
    } catch {
      showToast({ type: 'error', message: `Could not clear ${row.label.toLowerCase()}` });
    } finally {
      setClearing(null);
    }
  }, [showToast]);

  const onClear = useCallback((row: (typeof CACHE_ROWS)[number]) => {
    if (row.kind !== 'offline') {
      void runClear(row);
      return;
    }
    // Offline files must be downloaded again, so this one asks first.
    Alert.alert(
      'Clear offline files?',
      'These files will be removed from this iPhone. You will need to download them again to use them offline.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: () => void runClear(row) },
      ],
    );
  }, [runClear]);

  const updateProfile = useCallback(async (next: PerformanceStorageProfile) => {
    setProfile(next);
    await setPerformanceStorageSettings({ profile: next });
  }, []);


  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: c.line }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.ink }]}>Photo loading & quality</Text>
        <View style={styles.iconButton} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.amber} />}
      >
        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>On this iPhone</Text>
        <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]} testID="cache-usage">
          <View style={styles.totalBox}>
            <Text style={[styles.estimateLabel, { color: c.ink3 }]}>Local storage used by Beebeeb</Text>
            <Text style={[styles.estimateValue, { color: c.ink }]} testID="cache-usage-total">
              {usage ? formatBytes(usage.total) : '...'}
            </Text>
          </View>
          {CACHE_ROWS.map((row) => (
            <View
              key={row.kind}
              style={[styles.cacheRow, accessibilityLayout && styles.cacheRowAccessibility]}
              testID={`cache-row-${row.kind}`}
            >
              <View style={[styles.cacheCopy, accessibilityLayout && styles.cacheCopyAccessibility]}>
                <Text style={[styles.rowTitle, { color: c.ink }]}>{row.label}</Text>
                <Text style={[styles.rowSub, { color: c.ink3 }]}>{row.hint}</Text>
              </View>
              <Text style={[styles.cacheValue, { color: c.ink2 }]} testID={`cache-size-${row.kind}`}>
                {usage ? formatBytes(usage[row.kind]) : '...'}
              </Text>
              <TouchableOpacity
                onPress={() => onClear(row)}
                disabled={clearing !== null || !usage || usage[row.kind] === 0}
                style={[styles.clearButton, { borderColor: c.line2, opacity: clearing !== null || !usage || usage[row.kind] === 0 ? 0.4 : 1 }]}
                accessibilityRole="button"
                accessibilityLabel={`Clear ${row.label.toLowerCase()}`}
                testID={`cache-clear-${row.kind}`}
              >
                <Text style={[styles.clearText, { color: c.ink }]}>Clear</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>

        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Photo loading</Text>
        <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
          <View style={[styles.segment, accessibilityLayout && styles.segmentAccessibility]}>
            {PROFILES.map((item) => {
              const selected = profile === item;
              return (
                <TouchableOpacity
                  key={item}
                  onPress={() => void updateProfile(item)}
                  style={[
                    styles.segmentItem,
                    { backgroundColor: selected ? c.amber : 'transparent' },
                  ]}
                >
                  <Text style={[styles.segmentText, { color: selected ? '#16110a' : c.ink2 }]}>
                    {PROFILE_LABELS[item]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={[styles.body, { color: c.ink2 }]}>{profileCopy(profile)} This changes loading speed and local storage use, not the quality of your original photos.</Text>
          <Text style={[styles.caption, { color: c.ink4 }]} testID="cache-profile-estimate">
            {`Estimated about ${formatBytes(estimate.estimatedBytes)} for ${fileCount.toLocaleString()} files. Smooth adds a larger preview tier; originals load only when requested.`}
          </Text>
        </View>

        {Platform.OS === 'ios' ? <>
        {/* ── Photos ────────────────────────────────────────────────────── */}
        <Text style={[styles.sectionTitle, { color: c.ink3 }]}>Photos</Text>
        <TouchableOpacity
          style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}
          onPress={() => navigation.navigate('PhotoPreviews')}
          accessibilityRole="button"
          accessibilityLabel="Photo previews settings"
        >
          <View style={[styles.row, accessibilityLayout && styles.rowAccessibility]}>
            <Text style={[styles.rowTitle, { color: c.ink }]}>Photo previews</Text>
            <Ionicons name="chevron-forward" size={18} color={c.ink3} />
          </View>
          <Text style={[styles.rowSub, { color: c.ink3 }]}>
            Larger, sharper photos that open instantly. Choose format and size.
          </Text>
        </TouchableOpacity>

        </> : null}

        {queueStats && (queueStats.pending + queueStats.running + queueStats.failedRetry > 0) ? (
          <TouchableOpacity
            style={[styles.card, { backgroundColor: c.paper2, borderColor: c.amber, marginTop: 8 }]}
            onPress={() => navigation.navigate('ThumbnailWorker')}
            accessibilityRole="button"
            accessibilityLabel="View thumbnail improvement progress"
          >
            <Text style={[styles.rowTitle, { color: c.ink }]}>
              {`Improving thumbnails… ${queueStats.succeeded.toLocaleString()} done`}
            </Text>
            <Text style={[styles.rowSub, { color: c.ink3 }]}>
              {`${(queueStats.pending + queueStats.running + queueStats.failedRetry).toLocaleString()} remaining`}
            </Text>
          </TouchableOpacity>
        ) : null}

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
  card: { borderWidth: 1, borderRadius: 12, overflow: 'hidden', padding: 12, gap: 12 },
  segment: { flexDirection: 'row', borderRadius: 10, overflow: 'hidden' },
  segmentAccessibility: { flexDirection: 'column' },
  segmentItem: { flex: 1, paddingHorizontal: 8, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontSize: 13, fontWeight: '800', textAlign: 'center' },
  body: { fontSize: 13, lineHeight: 19 },
  totalBox: { gap: 4 },
  cacheRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cacheRowAccessibility: { alignItems: 'flex-start', flexWrap: 'wrap' },
  cacheCopy: { flex: 1 },
  cacheCopyAccessibility: { flexBasis: '100%' },
  cacheValue: { fontSize: 13, fontWeight: '700' },
  clearButton: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  clearText: { fontSize: 13, fontWeight: '700' },
  estimateBox: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
  estimateLabel: { fontSize: 12, fontWeight: '700' },
  estimateValue: { fontSize: 26, fontWeight: '900' },
  caption: { fontSize: 12, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowAccessibility: { alignItems: 'flex-start' },
  rowTitle: { fontSize: 15, fontWeight: '800' },
  rowSub: { fontSize: 12, lineHeight: 17 },
});
