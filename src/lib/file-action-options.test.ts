// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { itemActionOptions } from './file-action-options';

const labels = { offlineLabel: 'Make available offline', pinLabel: 'Pin to top', lockLabel: 'Lock file' };
const base = { ...labels, isMedia: false, isProtectedRoot: false };

describe('itemActionOptions', () => {
  test('a normal folder keeps Rename, Move and Delete', () => {
    const options = itemActionOptions({ ...base, isFolder: true });
    expect(options).toEqual(['Rename', 'Open', 'Share', 'Move to...', 'Make available offline', 'Delete', 'Pin to top', 'Lock file', 'Details', 'Cancel']);
  });

  test('the protected Backups root has no Rename, Move or Delete', () => {
    const options = itemActionOptions({ ...base, isFolder: true, isProtectedRoot: true });
    expect(options).not.toContain('Rename');
    expect(options).not.toContain('Move to...');
    expect(options).not.toContain('Delete');
    expect(options).not.toContain('Move to Trash');
    expect(options).toEqual(['Open', 'Share', 'Make available offline', 'Pin to top', 'Lock file', 'Details', 'Cancel']);
  });

  test('files keep their full menu, media adds Save to Photos', () => {
    const options = itemActionOptions({ ...base, isFolder: false, isMedia: true });
    expect(options).toEqual(['Rename', 'Preview', 'Share', 'Save to Files', 'Save to Photos', 'Duplicate', 'Move to...', 'Make available offline', 'Create proof', 'Lock file', 'Move to Trash', 'Details', 'Cancel']);
  });

  test('Duplicate is offered for files only, never folders', () => {
    expect(itemActionOptions({ ...base, isFolder: false })).toContain('Duplicate');
    expect(itemActionOptions({ ...base, isFolder: true })).not.toContain('Duplicate');
  });

  test('a file is never treated as the protected root', () => {
    const options = itemActionOptions({ ...base, isFolder: false, isProtectedRoot: true });
    expect(options).toContain('Move to Trash');
  });
});
