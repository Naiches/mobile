// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const files = readFileSync(join(import.meta.dir, 'FilesScreen.tsx'), 'utf8');
const preview = readFileSync(join(import.meta.dir, 'PreviewScreen.tsx'), 'utf8');
const app = readFileSync(join(import.meta.dir, '..', 'App.tsx'), 'utf8');

describe('Drive native folder navigation wiring', () => {
  test('the Files tab owns a native stack and folder rows push Folder routes', () => {
    expect(app).toContain('<FilesStack.Navigator');
    expect(app).toContain('component={FilesNavigator}');
    expect(files).toContain("navigation.push('Folder'");
  });

  test('FilesScreen no longer mutates a component-local folder stack', () => {
    expect(files).not.toContain('setFolderStack');
    expect(files).not.toMatch(/useState<BreadcrumbEntry\[\]>/);
  });

  test('Drive search hides the native tab bar from the navigator config', () => {
    expect(app).toContain('tabBarHidden={filesTabBarHidden}');
    expect(files).toContain('setFilesTabBarHidden(searchActive && !selectMode)');
  });

  test('the preview wires its pan end through the pure dismiss decision', () => {
    expect(preview).toContain('shouldDismissPreview({');
    expect(preview).toContain('closeBackdropOpacity');
    expect(preview).toContain('documentScrollOffsetRef');
  });
});
