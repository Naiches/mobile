/**
 * "Download my data": fetch the export ZIP with the session token into a
 * temporary file, offer it through the share sheet ("Save to Files", AirDrop…)
 * and delete it afterwards. The temp name is registered with the sign-out
 * plaintext purge (`beebeeb-data-export-` in caches-plaintext-registry.ts).
 *
 * Every failure carries a message that names the real cause, so the screen
 * never has to say a generic "try again".
 */

export class DataExportDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataExportDownloadError';
  }
}

export interface ExportFs {
  cacheDirectory: string | null;
  downloadAsync: (
    url: string,
    dest: string,
    options?: { headers?: Record<string, string> },
  ) => Promise<{ uri: string; status: number }>;
  readAsStringAsync: (uri: string) => Promise<string>;
  deleteAsync: (uri: string, options?: { idempotent?: boolean }) => Promise<void>;
}

export interface ExportSharing {
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: (uri: string, options: { mimeType: string; UTI: string; dialogTitle: string }) => Promise<void>;
}

export interface DataExportDownloadDeps {
  fs: ExportFs;
  sharing: ExportSharing;
  gatedWrite: <T>(label: string, uri: string, fs: ExportFs, write: () => Promise<T>) => Promise<T>;
  getToken: () => Promise<string | null>;
}

const EXPIRED = 'The export expired. Request a new one.';
const GONE = 'This export is no longer available. Request a new one.';
const LINK_INVALID = 'This export link is not valid any more. Request a new one.';
const SERVER = 'The server could not prepare your export. Try again later or request a new one.';

/** The user-facing cause for a non-200 answer. `body` is the (short) response text. */
export function describeExportFailure(status: number, body = ''): string {
  if (/expired/i.test(body)) return EXPIRED;
  if (status === 404 || status === 410) return GONE;
  if (status === 401 || status === 403) return LINK_INVALID;
  if (status >= 500) return SERVER;
  return `The download failed (error ${status}). Request a new export and try again.`;
}

async function safeDelete(fs: ExportFs, uri: string): Promise<void> {
  await fs.deleteAsync(uri, { idempotent: true }).catch(() => {});
}

async function readSmallBody(fs: ExportFs, uri: string): Promise<string> {
  try {
    return (await fs.readAsStringAsync(uri)).slice(0, 2000);
  } catch {
    return '';
  }
}

export async function downloadDataExport(
  input: { url?: string; exportId?: string },
  deps: DataExportDownloadDeps,
): Promise<'shared'> {
  const { fs, sharing } = deps;
  if (!input.url) throw new DataExportDownloadError('The export is not ready yet.');
  const dir = fs.cacheDirectory;
  if (!dir) throw new DataExportDownloadError('This device has no place to keep the download.');

  const token = await deps.getToken();
  const dest = `${dir}beebeeb-data-export-${input.exportId ?? 'latest'}.zip`;
  try {
    let result: { uri: string; status: number };
    try {
      result = await deps.gatedWrite('data export', dest, fs, () =>
        fs.downloadAsync(input.url as string, dest, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
      );
    } catch (err) {
      if (err instanceof DataExportDownloadError) throw err;
      if ((err as { name?: string } | null)?.name === 'AbortError') {
        throw new DataExportDownloadError('You were signed out. Sign in and request the export again.');
      }
      throw new DataExportDownloadError('No connection. Check your network and try again.');
    }
    if (result.status !== 200) {
      // downloadAsync saves an error body to the file without throwing.
      const body = await readSmallBody(fs, result.uri);
      throw new DataExportDownloadError(describeExportFailure(result.status, body));
    }
    if (!(await sharing.isAvailableAsync())) {
      throw new DataExportDownloadError('Sharing is not available on this device.');
    }
    try {
      await sharing.shareAsync(result.uri, {
        mimeType: 'application/zip',
        UTI: 'public.zip-archive',
        dialogTitle: 'Save your data export',
      });
    } catch {
      throw new DataExportDownloadError('Your export was downloaded but the share sheet could not open. Try again.');
    }
    return 'shared';
  } finally {
    await safeDelete(fs, dest);
  }
}
