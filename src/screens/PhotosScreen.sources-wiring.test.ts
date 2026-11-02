// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// The behaviour is unit-tested in the lib modules; these checks keep the
// screens wired to them.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const photos = read('./PhotosScreen.tsx');
const preview = read('./PreviewScreen.tsx');
const app = read('../App.tsx');
const settings = read('./SettingsScreen.tsx');

describe('Photos tab sources', () => {
  test('the grid is filtered by the chosen sources, not by every media row in the vault', () => {
    expect(photos).toContain('computeVisiblePhotos');
    expect(photos).toContain('getPhotoLibrary');
    expect(photos).toContain('loadPhotoSources');
  });

  test('chips and the sources entry points exist', () => {
    expect(photos).toContain('photos-source-chips');
    expect(photos).toContain('photos-sources-button');
    expect(photos).toContain('photos-choose-sources');
    expect(photos).toContain("navigation.navigate('PhotoSources')");
  });

  test('the sources screen is registered and reachable from Settings', () => {
    expect(app).toContain('name="PhotoSources"');
    expect(app).toContain('PhotoSources: undefined');
    expect(settings).toContain("navigation.navigate('PhotoSources')");
  });
});

describe('Photos tab refresh', () => {
  test('new backups: refreshes when the backed-up count rises, and on foreground', () => {
    expect(photos).toContain('backupCompletedAdvanced(lastBackupCompletedRef.current, completed)');
    expect(photos).toContain('returnedFromBackground(next)');
  });
});

describe('video opened as an image', () => {
  test('the pager is handed previewMimeType, never an image guess from the index row', () => {
    expect(photos).toContain('previewMimeType(p, mimesForPreview)');
    expect(photos).toContain('previewMimeType(entry, mimesForPreview)');
    expect(photos).not.toMatch(/mediaMimeType\(p\) \?\? p\.mime_type/);
  });
});

describe('Move from the viewer', () => {
  test('the folder tree comes from the index (Drive root included), the walk is only a fallback', () => {
    expect(preview).toContain('folderNodesFromIndex(files, MOVE_PICKER_MAX_FOLDERS)');
    expect(preview).toContain('loadMovePickerFolderNodes()');
  });
});

describe('the old exclusion filter is gone', () => {
  test('Photos has one filter (sources); no excluded-folder preference or screen remains', () => {
    expect(photos).not.toContain('photo-library-prefs');
    expect(photos).not.toContain('getExcludedPhotoFolderIds');
    expect(app).not.toContain('PhotoLibrarySettings');
    expect(settings).not.toContain('PhotoLibrarySettings');
    expect(settings).not.toContain('Folders shown in Photos');
    expect(app).toContain('clearLegacyPhotoExclusions');
  });
});
