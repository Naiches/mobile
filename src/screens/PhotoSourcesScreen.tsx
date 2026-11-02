import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../App';
import type { FileEntry } from '../lib/api';
import { friendlyError } from '../lib/api';
import { loadFileIndex } from '../lib/file-index-loader';
import { useCrypto } from '../lib/crypto-context';
import { useTheme } from '../lib/theme-context';
import { NativeSwitch } from '../components/NativeSwitch';
import FolderPickerModal, { type PickerFolder } from '../components/FolderPickerModal';
import { folderNodesFromIndex, movePickerFolderFallbackName } from '../lib/move-picker-folders';
import { getProtectedBackupsRootId } from '../lib/protected-folders';
import { resolveProtectedBackupsRoot } from '../services/BackupService';
import { resolveCameraRollDevices } from '../lib/photo-camera-roll-devices';
import { sourceFolderStatus, type CameraRollDevice, type PhotoSources } from '../lib/photo-source-filter';
import {
  buildFolderPath,
  makeFolderNameDecryptor,
  resolveFolderNames,
} from '../lib/photo-sources-view';
import {
  DEFAULT_PHOTO_SOURCES,
  loadPhotoSources,
  savePhotoSources,
  withCameraRollEnabled,
  withDeviceToggled,
  withFolderAdded,
  withFolderRemoved,
} from '../lib/photo-sources';

type Nav = NativeStackNavigationProp<RootStackParamList>;

interface FolderSourceRow {
  id: string;
  name: string;
  path: string;
  found: boolean;
}

export default function PhotoSourcesScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const accessibilityLayout = fontScale >= 1.3;
  const { decryptMetadata } = useCrypto();
  const decryptName = useMemo(() => makeFolderNameDecryptor(decryptMetadata), [decryptMetadata]);

  const [sources, setSources] = useState<PhotoSources>(DEFAULT_PHOTO_SOURCES);
  const sourcesRef = useRef(sources);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [devices, setDevices] = useState<CameraRollDevice[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [picker, setPicker] = useState<PickerFolder[] | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [loaded, index] = await Promise.all([loadPhotoSources(), loadFileIndex()]);
      const rows = index.files ?? [];
      const rootId = getProtectedBackupsRootId() ?? (await resolveProtectedBackupsRoot());
      const found = await resolveCameraRollDevices({ rows, backupsRootId: rootId, decryptName });
      // Names for every folder source and each of its ancestors, for the path line.
      const parentById = new Map(rows.map((r) => [r.id, r.parent_id ?? null]));
      const wanted = new Set<string>();
      for (const id of loaded.folders) {
        let cur: string | null = id;
        for (let depth = 0; cur && !wanted.has(cur) && depth < 64; depth += 1) {
          wanted.add(cur);
          cur = parentById.get(cur) ?? null;
        }
      }
      const resolved = await resolveFolderNames([...wanted], rows, decryptName);
      sourcesRef.current = loaded;
      setSources(loaded);
      setFiles(rows);
      setDevices(found);
      setNames(resolved);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }, [decryptName]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const update = useCallback(async (next: PhotoSources) => {
    const previous = sourcesRef.current;
    sourcesRef.current = next;
    setSources(next);
    setSaving(true);
    setError(null);
    try {
      await savePhotoSources(next);
    } catch (err) {
      sourcesRef.current = previous;
      setSources(previous);
      setError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  }, []);

  const folderRows = useMemo<FolderSourceRow[]>(() => {
    const status = sourceFolderStatus(files, sources);
    return sources.folders.map((id) => {
      const found = status.get(id) === true;
      const name = names.get(id) ?? 'Folder';
      return {
        id,
        name,
        found,
        path: found ? buildFolderPath(id, files, names).join(' › ') : '',
      };
    });
  }, [files, names, sources]);

  const openPicker = useCallback(async () => {
    const nodes = folderNodesFromIndex(files);
    const resolved = await resolveFolderNames(nodes.map((n) => n.id), files, decryptName);
    setNames((prev) => new Map([...prev, ...resolved]));
    setPicker(nodes.map((n) => ({
      id: n.id,
      name: resolved.get(n.id) ?? movePickerFolderFallbackName(n),
      parentId: n.parent_id,
    })));
  }, [decryptName, files]);

  const allDeviceIds = useMemo(() => devices.map((d) => d.id), [devices]);
  const deviceChecked = (id: string) => sources.cameraRoll.devices === 'all' || sources.cameraRoll.devices.includes(id);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]} testID="photo-sources-screen">
      <View style={[styles.header, accessibilityLayout && styles.headerAccessibility, { paddingTop: insets.top + 10, borderBottomColor: c.line }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel="Back"
          testID="photo-sources-back"
        >
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.ink }]} numberOfLines={2}>Photo sources</Text>
        <View style={styles.iconButton}>{saving ? <ActivityIndicator color={c.amber} /> : null}</View>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
        <Text style={[styles.body, { color: c.ink2 }]}>
          Choose what shows in Photos. This applies on all your devices.
        </Text>

        {error ? (
          <View style={[styles.card, styles.errorCard, { backgroundColor: c.paper2, borderColor: c.line }]}>
            <Text style={[styles.rowSubtitle, { color: c.ink2 }]} testID="photo-sources-error">{error}</Text>
            <TouchableOpacity onPress={() => void load()} accessibilityRole="button" testID="photo-sources-retry">
              <Text style={[styles.action, { color: c.amberDeep }]}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {loading ? (
          <View style={styles.loadingBox}><ActivityIndicator color={c.amber} /></View>
        ) : (
          <>
            <Text style={[styles.sectionLabel, { color: c.ink3 }]}>CAMERA ROLL BACKUPS</Text>
            <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
              <View style={[styles.row, accessibilityLayout && styles.rowAccessibility]}>
                <View style={styles.rowText}>
                  <Text style={[styles.rowLabel, { color: c.ink }]}>Camera roll backups</Text>
                  <Text style={[styles.rowSubtitle, { color: c.ink3 }]}>Photos and videos backed up from your phones and tablets.</Text>
                </View>
                <NativeSwitch
                  value={sources.cameraRoll.enabled}
                  onValueChange={(v) => void update(withCameraRollEnabled(sources, v))}
                  colors={c}
                  testID="photo-sources-camera-roll-switch"
                />
              </View>
              {sources.cameraRoll.enabled ? (
                <>
                  <View style={[styles.divider, { backgroundColor: c.line }]} />
                  <TouchableOpacity
                    style={[styles.row, accessibilityLayout && styles.rowAccessibility]}
                    onPress={() => void update({ ...sources, cameraRoll: { ...sources.cameraRoll, devices: 'all' } })}
                    accessibilityRole="button"
                    accessibilityState={{ selected: sources.cameraRoll.devices === 'all' }}
                    testID="photo-sources-device-all"
                  >
                    <Text style={[styles.rowLabel, styles.rowText, { color: c.ink }]}>All devices</Text>
                    {sources.cameraRoll.devices === 'all' ? <Ionicons name="checkmark" size={20} color={c.amberDeep} /> : null}
                  </TouchableOpacity>
                  {devices.map((device) => (
                    <View key={device.id}>
                      <View style={[styles.divider, { backgroundColor: c.line }]} />
                      <TouchableOpacity
                        style={[styles.row, accessibilityLayout && styles.rowAccessibility]}
                        onPress={() => void update(withDeviceToggled(sources, device.id, allDeviceIds))}
                        accessibilityRole="button"
                        accessibilityState={{ selected: deviceChecked(device.id) }}
                        testID={`photo-sources-device-${device.id}`}
                      >
                        <Text style={[styles.rowLabel, styles.rowText, { color: c.ink }]} numberOfLines={accessibilityLayout ? undefined : 1}>{device.name}</Text>
                        {deviceChecked(device.id) && sources.cameraRoll.devices !== 'all'
                          ? <Ionicons name="checkmark" size={20} color={c.amberDeep} />
                          : null}
                      </TouchableOpacity>
                    </View>
                  ))}
                  {devices.length === 0 ? (
                    <>
                      <View style={[styles.divider, { backgroundColor: c.line }]} />
                      <View style={[styles.row, accessibilityLayout && styles.rowAccessibility]}>
                        <Text style={[styles.rowSubtitle, { color: c.ink3 }]}>No device has backed up its camera roll yet.</Text>
                      </View>
                    </>
                  ) : null}
                </>
              ) : null}
            </View>

            <Text style={[styles.sectionLabel, { color: c.ink3 }]}>DRIVE FOLDERS</Text>
            <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
              {folderRows.map((row) => (
                <View key={row.id}>
                  <View style={[styles.row, accessibilityLayout && styles.rowAccessibility]} testID={`photo-sources-folder-${row.id}`}>
                    <View style={styles.rowText}>
                      <Text style={[styles.rowLabel, { color: row.found ? c.ink : c.ink3 }]} numberOfLines={accessibilityLayout ? undefined : 1}>
                        {row.found ? row.name : 'Folder not found'}
                      </Text>
                      <Text style={[styles.rowSubtitle, { color: c.ink3 }]} numberOfLines={accessibilityLayout ? undefined : 2}>
                        {row.found ? row.path : 'It was deleted or moved to the trash. Remove it from the list.'}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => void update(withFolderRemoved(sources, row.id))}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${row.found ? row.name : 'folder'}`}
                      testID={`photo-sources-remove-${row.id}`}
                    >
                      <Text style={[styles.action, { color: c.amberDeep }]}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                  <View style={[styles.divider, { backgroundColor: c.line }]} />
                </View>
              ))}
              <TouchableOpacity
                style={[styles.row, accessibilityLayout && styles.rowAccessibility]}
                onPress={() => void openPicker()}
                accessibilityRole="button"
                testID="photo-sources-add-folder"
              >
                <Ionicons name="add-circle-outline" size={22} color={c.amberDeep} />
                <Text style={[styles.rowLabel, styles.rowText, { color: c.amberDeep }]}>Add a folder</Text>
              </TouchableOpacity>
            </View>
            <Text style={[styles.note, { color: c.ink3 }]}>
              A folder includes everything inside it, subfolders too. To show only a subfolder, add that subfolder instead.
            </Text>
          </>
        )}
      </ScrollView>

      <FolderPickerModal
        visible={picker !== null}
        title="Add a folder"
        folders={picker ?? []}
        currentParentId={null}
        confirmLabel={(name) => `Add “${name}”`}
        blockRootHint="Open a folder to add it."
        onCancel={() => setPicker(null)}
        onConfirm={(targetId) => {
          setPicker(null);
          if (targetId) void update(withFolderAdded(sourcesRef.current, targetId));
        }}
        testID="photo-sources-picker"
      />
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
  headerAccessibility: { alignItems: 'flex-start', paddingBottom: 8 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '800' },
  scroll: { flex: 1 },
  body: { fontSize: 13, lineHeight: 19, marginBottom: 16 },
  loadingBox: { paddingVertical: 32, alignItems: 'center' },
  sectionLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, marginBottom: 8, marginTop: 4 },
  card: { borderWidth: 1, borderRadius: 12, overflow: 'hidden', marginBottom: 16 },
  errorCard: { padding: 14, gap: 8 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 14 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 12 },
  rowAccessibility: { alignItems: 'flex-start', flexWrap: 'wrap' },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 15, fontWeight: '600' },
  rowSubtitle: { fontSize: 12, marginTop: 2, lineHeight: 17 },
  action: { fontSize: 14, fontWeight: '600' },
  note: { fontSize: 12, lineHeight: 17 },
});
