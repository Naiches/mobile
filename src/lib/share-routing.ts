/**
 * Where a file shared to Beebeeb lands when the user did not pick a folder.
 *
 * A small rules table: an app's export file name pattern sends the file to `Backups › <App>`.
 * WhatsApp is the only row; another app is added by adding a row. The folder itself is found or
 * created by the backup service (`ensureAppBackupFolder`), one per account, never per device.
 */
export interface ShareRouteRule {
  /** The app's name, also the folder name under Backups. */
  app: string;
  /** Matched against the shared file's name. */
  pattern: RegExp;
}

export const SHARE_ROUTE_RULES: readonly ShareRouteRule[] = [
  { app: 'WhatsApp', pattern: /^WhatsApp Chat - .+\.(zip|txt)$/i },
];

export function matchShareRoute(filename: string): ShareRouteRule | null {
  return SHARE_ROUTE_RULES.find((rule) => rule.pattern.test(filename)) ?? null;
}

/** Counts of files saved to an app folder, keyed by app name. */
export type RoutedShareCounts = Record<string, number>;

const destination = (app: string) => `Backups › ${app}`;

/** The toast after a share import: where the files went when some were routed. */
export function shareImportMessage(result: { uploaded: number; routed: RoutedShareCounts }): string {
  const apps = Object.keys(result.routed);
  const routedCount = apps.reduce((sum, app) => sum + result.routed[app], 0);
  const plural = (n: number) => (n === 1 ? 'file' : 'files');
  if (routedCount === 0) return `${result.uploaded} ${plural(result.uploaded)} imported from share sheet`;
  const place = apps.length === 1 ? destination(apps[0]) : 'Backups';
  if (routedCount === result.uploaded) {
    return result.uploaded === 1 ? `Saved to ${place}` : `${result.uploaded} files saved to ${place}`;
  }
  return `${result.uploaded} ${plural(result.uploaded)} imported from share sheet (${routedCount} saved to ${place})`;
}
