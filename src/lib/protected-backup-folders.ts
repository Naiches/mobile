/** Direct child of Backups owned by the separate beebeeb Mail Backup app. */
export const MAIL_BACKUP_FOLDER_NAME = 'beebeeb Mail Backup';

/** Intentionally exact: only the reserved decrypted folder name is protected. */
export function isMailBackupFolderName(name: string | null | undefined): boolean {
  return name === MAIL_BACKUP_FOLDER_NAME;
}
