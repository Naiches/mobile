// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, test } from 'bun:test';
import { MAIL_BACKUP_FOLDER_NAME, isMailBackupFolderName } from './protected-backup-folders';

describe('mail backup folder reservation', () => {
  test('matches only the exact decrypted direct-child name', () => {
    expect(MAIL_BACKUP_FOLDER_NAME).toBe('beebeeb Mail Backup');
    expect(isMailBackupFolderName('beebeeb Mail Backup')).toBe(true);
    expect(isMailBackupFolderName('Beebeeb Mail Backup')).toBe(false);
    expect(isMailBackupFolderName('beebeeb Mail Backup ')).toBe(false);
    expect(isMailBackupFolderName(null)).toBe(false);
  });
});
