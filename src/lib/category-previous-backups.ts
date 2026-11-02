/**
 * "Previous backups" for Contacts and Calendar, plus the small pure helpers
 * Backup Insights uses for activity and the latest verification attempt.
 *
 * Listing only: the server already keeps earlier versions of each backup file
 * (up to 10, or 30 days). There is no restore or import here.
 */

import {
  buildPreviousBackups,
  type CategoryKind,
  type CategoryRun,
  type PreviousBackup,
  type VersionLike,
} from './category-backup-status';

export interface LoadPreviousBackupsDeps {
  /** Server folder holding the category's backup files (native status `parentFolderId`). */
  parentFolderId: string | null | undefined;
  /** Runs recorded on this device, used to put a count on a version. */
  runs: CategoryRun[];
  listFiles: (parentId: string) => Promise<{ id: string; is_folder: boolean }[]>;
  listFileVersions: (fileId: string) => Promise<VersionLike[]>;
}

/** Folder files to read versions for: a calendar folder has one file per calendar. */
const MAX_FILES = 12;

export async function loadPreviousBackups(deps: LoadPreviousBackupsDeps): Promise<PreviousBackup[]> {
  if (!deps.parentFolderId) return [];
  const files = (await deps.listFiles(deps.parentFolderId)).filter((f) => !f.is_folder).slice(0, MAX_FILES);
  const perFile = await Promise.all(
    files.map((f) => deps.listFileVersions(f.id).catch((): VersionLike[] => [])),
  );
  return buildPreviousBackups(perFile, deps.runs);
}

export interface CategoryActivityEntry {
  kind: CategoryKind;
  at: string;
  count: number;
}

/** Recent uploaded runs of both categories, newest first, for the activity list. */
export function buildCategoryActivity(
  contactsRuns: CategoryRun[],
  calendarRuns: CategoryRun[],
  limit = 5,
): CategoryActivityEntry[] {
  return [
    ...contactsRuns.map((r) => ({ kind: 'contacts' as const, at: r.at, count: r.count })),
    ...calendarRuns.map((r) => ({ kind: 'calendar' as const, at: r.at, count: r.count })),
  ]
    .filter((e) => !Number.isNaN(Date.parse(e.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

interface CategoryVerificationInput {
  verifiedAt?: string | null;
  lastRunStatus?: 'ok' | 'failed' | null;
  lastRunAt?: string | null;
  lastError?: string | null;
}

export interface VerificationAttempt {
  at: string;
  kind: 'photo' | CategoryKind;
  success: boolean;
}

/** SQLite stores UTC timestamps with a space and without an explicit zone. */
function canonicalVerificationTime(value: string | null | undefined): { at: string; ms: number } | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  const parseable = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const ms = Date.parse(parseable);
  if (Number.isNaN(ms)) return null;
  return { at: new Date(ms).toISOString(), ms };
}

/**
 * The newest verification attempt across camera roll, Contacts, and Calendar.
 * Category run failures count only when verification itself failed; permission,
 * export, and upload failures are not verification attempts. A newer failure
 * intentionally replaces an older green success in Backup Insights.
 */
export function latestVerificationAttempt(input: {
  photo?: { verifiedAt?: string | null; success: boolean } | null;
  contacts?: CategoryVerificationInput | null;
  calendar?: CategoryVerificationInput | null;
}): VerificationAttempt | null {
  const candidates: Array<VerificationAttempt & { ms: number }> = [];
  const add = (
    value: string | null | undefined,
    kind: VerificationAttempt['kind'],
    success: boolean,
  ) => {
    const time = canonicalVerificationTime(value);
    if (time) candidates.push({ ...time, kind, success });
  };

  if (input.photo) add(input.photo.verifiedAt, 'photo', input.photo.success);

  for (const [kind, status] of [
    ['contacts', input.contacts],
    ['calendar', input.calendar],
  ] as const) {
    add(status?.verifiedAt, kind, true);
    if (status?.lastRunStatus === 'failed' && status.lastError === 'verify_failed') {
      add(status.lastRunAt, kind, false);
    }
  }

  candidates.sort((a, b) => (b.ms - a.ms) || (Number(a.success) - Number(b.success)));
  const newest = candidates[0];
  return newest
    ? { at: newest.at, kind: newest.kind, success: newest.success }
    : null;
}
