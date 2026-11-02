/**
 * The long-press menu entries for one Drive row. The root "Backups" folder is a protected system
 * folder, so it never offers Rename, Move or Delete (see lib/protected-folders).
 */
export function itemActionOptions(opts: {
  isFolder: boolean;
  isMedia: boolean;
  isProtectedRoot: boolean;
  offlineLabel: string;
  pinLabel: string;
  lockLabel: string;
}): string[] {
  if (opts.isFolder) {
    const protectedRoot = opts.isProtectedRoot;
    return [
      ...(protectedRoot ? [] : ['Rename']),
      'Open',
      'Share',
      ...(protectedRoot ? [] : ['Move to...']),
      opts.offlineLabel,
      ...(protectedRoot ? [] : ['Delete']),
      opts.pinLabel,
      opts.lockLabel,
      'Details',
      'Cancel',
    ];
  }
  const fileOptions = ['Rename', 'Preview', 'Share', 'Save to Files'];
  if (opts.isMedia) fileOptions.push('Save to Photos');
  fileOptions.push('Duplicate', 'Move to...', opts.offlineLabel, 'Create proof', opts.lockLabel, 'Move to Trash', 'Details');
  return [...fileOptions, 'Cancel'];
}
