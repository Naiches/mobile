// @ts-nocheck
/**
 * Every surface that lists files drops the internal backup manifest through the ONE rule in
 * hidden-system-files.ts (Files app extension: FileProviderItem.isHiddenBackupManifest, covered by
 * the extension behaviour harness). This guard lists the surfaces so a new one cannot skip it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { photoCandidatesFromIndex } from './photo-candidates';
import { collectAllFolders } from './move-picker-folders';
import { guides } from './backup-guides';

const ROOT = join(import.meta.dir, '..', '..');
const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('surfaces use the shared hide rule', () => {
  const files = src('src/screens/FilesScreen.tsx');
  const trash = src('src/screens/TrashScreen.tsx');

  test('Drive: the listing every row starts from is filtered', () => {
    expect(files).toContain("from '../lib/hidden-system-files'");
    expect(files).toContain('hideDeviceManifests(files,');
    expect(files).toContain('let result = uniqueFileEntries(visibleFiles);');
  });

  test('Recents (the strip and the last-24-hours filter) start from the filtered listing', () => {
    expect(files).toMatch(/const recentFiles = useMemo\(\(\) => \(\s+uniqueFileEntries\(visibleFiles\)/);
    expect(files).toContain('recentFilterActive');
    expect(files).not.toMatch(/uniqueFileEntries\(files\)/);
  });

  test('counts and the select-mode entry use the filtered listing', () => {
    expect(files).toContain('visibleFiles.length > 0');
  });

  test('Search: results are filtered and the manifest is never added to the index', () => {
    expect(files).toMatch(/searchVault\(query\)\.filter\(\s+\(match\) => !isDeviceManifest\(/);
    expect(files).toMatch(/if \(isDeviceManifest\(metadata\.name, node\.parent_id,/);
  });

  test('Trash: the list is filtered, and Empty Trash purges the hidden copies too', () => {
    expect(trash).toContain('projectVisibleTopLevelTrashItems(allTrashEntries, localParentOf, localTrashName)');
    expect(trash).toContain('setHiddenIds(projection.hidden.map((entry) => entry.id))');
    expect(trash).toContain('const idsToDelete = [...new Set([...visibleIds, ...hiddenIds])]');
  });

  test('the shared Trash projection resolves missing parents and legacy Backups roots', () => {
    const projection = src('src/lib/trash-count.ts');
    expect(projection).toContain('resolveTrashParentIds(manifestParentIds, parentById, parentOf)');
    expect(projection).toContain('trashedBackupsRoots');
    expect(projection).toContain('hideDeviceManifests(');
  });

  test('the backup service names the manifest through the shared constant', () => {
    const backup = src('src/services/BackupService.ts');
    expect(backup).toContain('const MANIFEST_FILENAME = DEVICE_MANIFEST_NAME;');
  });

  test('the Files app extension carries the rule and the enumerator applies it to every listing', () => {
    const item = src('targets/file-provider/FileProviderItem.swift');
    const enumerator = src('targets/file-provider/FileProviderEnumerator.swift');
    expect(item).toContain('var isHiddenBackupManifest: Bool');
    expect(enumerator).toContain('.filter { !$0.isHiddenBackupManifest }');
    expect(enumerator.match(/cache\.children\(/g)?.length).toBe(1);
  });
});

describe('the hide rule does not restart effects on every sync event', () => {
  // The sync context value changes on every op, status change and tree bump. The parent lookup is a
  // dependency of the whole-vault search reconcile effect, so it may depend on the stable getNode only.
  test('FilesScreen parent lookup depends on sync.getNode, never on the whole sync value', () => {
    const files = src('src/screens/FilesScreen.tsx');
    const lookup = files.slice(files.indexOf('const parentIdOf = useCallback('), files.indexOf('const parentIdOf = useCallback(') + 300);
    expect(lookup).toContain('getNodeById(id)?.parent_id');
    expect(lookup).toContain('[getNodeById, allEntries]');
    expect(lookup).not.toMatch(/\[sync\b/);
  });

  test('TrashScreen refreshes only when its shared projection inputs change', () => {
    const trash = src('src/screens/TrashScreen.tsx');
    expect(trash).toContain('}, [localParentOf]);');
    expect(trash).not.toContain('useSyncOptional');
  });
});

describe('Photos and pickers cannot list the manifest', () => {
  test('the Photos candidates are media only: a manifest row is not one', () => {
    const manifest = { id: 'm', name: '.device.json', name_encrypted: '{}', mime_type: 'application/json', is_folder: false, parent_id: 'D' };
    expect(photoCandidatesFromIndex([manifest])).toEqual([]);
  });

  test('the Move / upload-destination pickers list folders only', async () => {
    const rows = {
      root: [{ id: 'B', name_encrypted: 'x', parent_id: null, is_folder: true }],
      B: [
        { id: 'D', name_encrypted: 'x', parent_id: 'B', is_folder: true },
        { id: 'm', name_encrypted: 'x', parent_id: 'B', is_folder: false },
      ],
      D: [{ id: 'm2', name_encrypted: 'x', parent_id: 'D', is_folder: false }],
    };
    const folders = await collectAllFolders(async (parent) => rows[parent ?? 'root'] ?? []);
    expect(folders.map((f) => f.id)).toEqual(['B', 'D']);
  });
});

describe('WhatsApp guide', () => {
  test('says where the export is saved', () => {
    const whatsapp = guides.find((g) => g.id === 'whatsapp');
    expect(`${whatsapp.steps.join(' ')} ${whatsapp.note}`).toContain('Backups › WhatsApp');
  });
});
