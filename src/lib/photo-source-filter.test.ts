// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, test } from 'bun:test';
import {
  CAMERA_ROLL_SOURCE,
  DEFAULT_PHOTO_SOURCES,
  applyPhotoSources,
  buildSourceChips,
  buildSourceMembership,
  filterBySourceKey,
  sourceFolderStatus,
} from './photo-source-filter';

const folder = (id, parent = null, extra = {}) => ({ id, parent_id: parent, is_folder: true, ...extra });
const photo = (id, parent = null) => ({ id, parent_id: parent, is_folder: false });

// Backups (root) > Phone > Camera Roll ; Backups > Tablet > Camera Roll ; Drive > Camera > 2025
const tree = [
  folder('backups'),
  folder('phone', 'backups'),
  folder('phone-cr', 'phone'),
  folder('phone-cr-sub', 'phone-cr'),
  folder('phone-contacts', 'phone'),
  folder('tablet', 'backups'),
  folder('tablet-cr', 'tablet'),
  folder('cam'),
  folder('cam-2025', 'cam'),
  folder('cam-2025-trip', 'cam-2025'),
  folder('docs'),
  folder('empty'),
];
const devices = [
  { id: 'phone', name: 'Phone', cameraRollFolderIds: ['phone-cr'] },
  { id: 'tablet', name: 'Tablet', cameraRollFolderIds: ['tablet-cr'] },
];
const media = [
  photo('p-phone', 'phone-cr'),
  photo('p-phone-sub', 'phone-cr-sub'),
  photo('p-phone-contacts', 'phone-contacts'),
  photo('p-tablet', 'tablet-cr'),
  photo('p-cam', 'cam'),
  photo('p-2025', 'cam-2025'),
  photo('p-trip', 'cam-2025-trip'),
  photo('p-docs', 'docs'),
  photo('p-root', null),
];
const rows = [...tree, ...media];
const ids = (r) => r.photos.map((p) => p.id).sort();
const run = (sources) => applyPhotoSources(media, buildSourceMembership(rows, sources, devices));
const withFolders = (folders, camera = DEFAULT_PHOTO_SOURCES.cameraRoll) => ({ cameraRoll: camera, folders });

describe('applyPhotoSources', () => {
  test('defaults show camera-roll backups of every device and nothing else', () => {
    expect(ids(run(DEFAULT_PHOTO_SOURCES))).toEqual(['p-phone', 'p-phone-sub', 'p-tablet']);
  });

  test('camera roll off shows nothing without folder sources', () => {
    expect(ids(run(withFolders([], { enabled: false, devices: 'all' })))).toEqual([]);
  });

  test('a device subset keeps only those devices', () => {
    const sources = withFolders([], { enabled: true, devices: ['tablet'] });
    expect(ids(run(sources))).toEqual(['p-tablet']);
  });

  test('a device that is gone contributes nothing', () => {
    const sources = withFolders([], { enabled: true, devices: ['ghost'] });
    expect(ids(run(sources))).toEqual([]);
  });

  test('a folder source includes its subfolders at any depth', () => {
    const sources = withFolders(['cam'], { enabled: false, devices: 'all' });
    expect(ids(run(sources))).toEqual(['p-2025', 'p-cam', 'p-trip']);
  });

  test('a subfolder added on its own shows only that subtree', () => {
    const sources = withFolders(['cam-2025'], { enabled: false, devices: 'all' });
    expect(ids(run(sources))).toEqual(['p-2025', 'p-trip']);
  });

  test('overlapping sources list a photo once and tag it with each source', () => {
    const sources = withFolders(['cam', 'cam-2025']);
    const result = run(sources);
    expect(result.photos.filter((p) => p.id === 'p-trip')).toHaveLength(1);
    expect(result.sourceById.get('p-trip').sort()).toEqual(['cam', 'cam-2025']);
    expect(result.sourceById.get('p-phone')).toEqual([CAMERA_ROLL_SOURCE]);
  });

  test('a folder source that is no longer in the index shows nothing and is reported missing', () => {
    const live = rows.filter((r) => r.id !== 'cam');
    const sources = withFolders(['cam'], { enabled: false, devices: 'all' });
    const membership = buildSourceMembership(live, sources, devices);
    // the trashed folder's children may still be in a stale index: they must not leak in
    expect(applyPhotoSources(media, membership).photos).toEqual([]);
    expect(sourceFolderStatus(live, sources).get('cam')).toBe(false);
    expect(sourceFolderStatus(rows, sources).get('cam')).toBe(true);
  });

  test('a trashed source folder (flagged row) counts as not found', () => {
    const flagged = rows.map((r) => (r.id === 'cam' ? { ...r, is_trashed: true } : r));
    const sources = withFolders(['cam'], { enabled: false, devices: 'all' });
    expect(ids(applyPhotoSources(media, buildSourceMembership(flagged, sources, devices)))).toEqual([]);
    expect(sourceFolderStatus(flagged, sources).get('cam')).toBe(false);
  });

  test('a cycle in the parent links terminates', () => {
    const cyclic = [folder('a', 'b'), folder('b', 'a'), photo('in-a', 'a'), photo('in-b', 'b'), photo('out', null)];
    const sources = withFolders(['a'], { enabled: false, devices: 'all' });
    const membership = buildSourceMembership(cyclic, sources, []);
    expect(ids(applyPhotoSources(cyclic.filter((r) => !r.is_folder), membership))).toEqual(['in-a', 'in-b']);
  });

  test('a folder that is its own parent terminates', () => {
    const self = [folder('s', 's'), photo('x', 's')];
    const membership = buildSourceMembership(self, withFolders(['s'], { enabled: false, devices: 'all' }), []);
    expect(ids(applyPhotoSources([self[1]], membership))).toEqual(['x']);
  });

  test('membership is computed once per tree: applying it does no per-row walk', () => {
    let reads = 0;
    const counting = media.map((m) => ({
      ...m,
      get parent_id() { reads += 1; return m.parent_id; },
    }));
    const membership = buildSourceMembership(rows, DEFAULT_PHOTO_SOURCES, devices);
    applyPhotoSources(counting, membership);
    expect(reads).toBe(media.length);
  });
});

describe('source chips', () => {
  const names = new Map([['cam', 'Camera'], ['cam-2025', '2025']]);

  test('hidden with one source', () => {
    expect(buildSourceChips(DEFAULT_PHOTO_SOURCES, names)).toEqual([]);
    expect(buildSourceChips(withFolders(['cam'], { enabled: false, devices: 'all' }), names)).toEqual([]);
  });

  test('All, Camera roll, then one chip per folder', () => {
    expect(buildSourceChips(withFolders(['cam', 'cam-2025']), names)).toEqual([
      { key: 'all', label: 'All' },
      { key: CAMERA_ROLL_SOURCE, label: 'Camera roll' },
      { key: 'cam', label: 'Camera' },
      { key: 'cam-2025', label: '2025' },
    ]);
  });

  test('camera roll off drops its chip; a folder with no known name gets a plain label', () => {
    const chips = buildSourceChips(withFolders(['cam', 'unknown'], { enabled: false, devices: 'all' }), names);
    expect(chips.map((c) => c.key)).toEqual(['all', 'cam', 'unknown']);
    expect(chips[2].label).toBe('Folder');
  });

  test('a chip filters the grid to its source; All shows everything', () => {
    const result = run(withFolders(['cam', 'cam-2025']));
    expect(filterBySourceKey(result, 'all')).toBe(result.photos);
    expect(filterBySourceKey(result, CAMERA_ROLL_SOURCE).map((p) => p.id).sort()).toEqual(['p-phone', 'p-phone-sub', 'p-tablet']);
    expect(filterBySourceKey(result, 'cam-2025').map((p) => p.id).sort()).toEqual(['p-2025', 'p-trip']);
    expect(filterBySourceKey(result, 'cam').map((p) => p.id).sort()).toEqual(['p-2025', 'p-cam', 'p-trip']);
  });

  test('a chip with no photos shows an empty grid, not everything', () => {
    const result = run(withFolders(['empty']));
    expect(filterBySourceKey(result, 'empty')).toEqual([]);
  });
});
