/**
 * Contacts and Calendar backup status, derived from the truth.
 *
 * On or Off comes from the real setting on this device, never from the
 * server's per-device manifest: the manifest is fetched with a short timeout
 * and can be missing, slow or stale, and it describes other devices too. It is
 * only a secondary source for the last backup time and count (older data).
 *
 * Pure: no React, no native calls. The native managers supply `native`
 * (their `status()`), the settings supply `settingEnabled`.
 */

import { formatBytes } from './format';

export type CategoryKind = 'contacts' | 'calendar';

export interface CategoryRun {
  /** ISO time the run finished. */
  at: string;
  /** Items in that run's backup (contacts or events). */
  count: number;
  bytes: number;
}

/** The fields of the native `status()` this derivation reads. */
export interface CategoryNativeInput {
  lastScanAt?: string | null;
  lastScanCount?: number;
  lastUploadAt?: string | null;
  running?: boolean;
  progressDone?: number;
  progressTotal?: number;
  /** Live OS permission: denied or restricted. */
  permissionDenied?: boolean;
  /** Live OS permission: the user shared only some contacts (limited access). */
  limitedAccess?: boolean;
  lastRunStatus?: 'ok' | 'failed' | null;
  lastRunAt?: string | null;
  lastError?: string | null;
  verifiedCount?: number | null;
  /** Count of the export a drop rule refused (set only with `incomplete_export`). */
  refusedCount?: number | null;
  verifiedAt?: string | null;
  runs?: CategoryRun[];
}

export interface CategoryManifestInput {
  enabled?: boolean;
  last_sync?: string | null;
  items_synced?: number;
}

export interface DeriveInput {
  kind: CategoryKind;
  settingEnabled: boolean;
  native: CategoryNativeInput | null | undefined;
  manifest?: CategoryManifestInput | null;
  now?: number;
}

export type CategoryState = 'off' | 'waiting' | 'running' | 'ok' | 'error';

export interface CategoryRowStatus {
  state: CategoryState;
  text: string;
  /** 0..1 while running with a known total, otherwise null. */
  fraction: number | null;
  /** True when the backup was parsed back and the counts matched. */
  checked: boolean;
  /** The fix for an error row. */
  action: 'open_settings' | 'retry' | 'backup_anyway' | null;
  /** For `backup_anyway`: the one question to ask before the forced upload. */
  confirmText: string | null;
  lastBackupAt: string | null;
  count: number | null;
}

const WORDS: Record<CategoryKind, { label: string; lower: string; one: string; many: string }> = {
  contacts: { label: 'Contacts', lower: 'contacts', one: 'contact', many: 'contacts' },
  calendar: { label: 'Calendar', lower: 'calendar', one: 'event', many: 'events' },
};

export function timeAgoFromIso(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'earlier';
  const sec = Math.floor((now - t) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function countLabel(kind: CategoryKind, n: number): string {
  const w = WORDS[kind];
  return `${n.toLocaleString('en-US')} ${n === 1 ? w.one : w.many}`;
}

function base(state: CategoryState, text: string): CategoryRowStatus {
  return { state, text, fraction: null, checked: false, action: null, confirmText: null, lastBackupAt: null, count: null };
}

function limitedAccessStatus(lower: string): CategoryRowStatus {
  const out = base('error', `Beebeeb can only see some ${lower}. Allow full access to back up all of them`);
  out.action = 'open_settings';
  return out;
}

export function deriveCategoryBackupStatus(input: DeriveInput): CategoryRowStatus {
  const { kind, settingEnabled, native, manifest } = input;
  const now = input.now ?? Date.now();
  const w = WORDS[kind];

  if (!settingEnabled) return base('off', 'Off');

  if (native?.running) {
    const total = native.progressTotal ?? 0;
    const done = Math.min(native.progressDone ?? 0, total > 0 ? total : Number.MAX_SAFE_INTEGER);
    const out = base('running', total > 0
      ? `Backing up ${w.lower}… ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`
      : `Backing up ${w.lower}…`);
    out.fraction = total > 0 ? Math.min(done / total, 1) : null;
    return out;
  }

  if (native?.permissionDenied) {
    const out = base('error', `No access to ${w.label} · Open Settings`);
    out.action = 'open_settings';
    return out;
  }

  if (native?.limitedAccess) return limitedAccessStatus(w.lower);

  if (native?.lastRunStatus === 'failed') {
    const err = native.lastError ?? '';
    let text: string;
    let action: 'open_settings' | 'retry' = 'retry';
    if (err === 'permission_denied') {
      text = `No access to ${w.label} · Open Settings`;
      action = 'open_settings';
    } else if (err === 'limited_access') {
      return limitedAccessStatus(w.lower);
    } else if (err === 'incomplete_export') {
      const out = base('error', `${w.label} look${kind === 'contacts' ? '' : 's'} incomplete on this iPhone; the last good backup was kept`);
      out.lastBackupAt = native.lastUploadAt ?? null;
      const was = native.verifiedCount;
      const now = native.refusedCount;
      if (typeof was === 'number' && typeof now === 'number') {
        out.action = 'backup_anyway';
        out.text += ' · Back up anyway';
        out.confirmText = `Replace your last backup (${countLabel(kind, was)}) with this one (${countLabel(kind, now)})? Earlier versions stay available for 30 days.`;
      }
      return out;
    } else if (err === 'baseline_unavailable') {
      text = "Couldn't check your existing backup, nothing was uploaded · Try again";
    } else if (err === 'nothing_to_back_up') {
      return base('waiting', `No ${w.many} to back up yet`);
    } else if (err === 'verify_failed') {
      text = "Backup didn't pass its check, previous backup kept · Try again";
    } else if (err === 'export_failed') {
      text = `Couldn't read ${w.label} · Try again`;
    } else {
      text = "Couldn't upload · Try again";
    }
    const out = base('error', text);
    out.action = action;
    out.lastBackupAt = native.lastUploadAt ?? null;
    return out;
  }

  if (native?.lastRunStatus === 'ok' && native.lastRunAt) {
    const count = native.verifiedCount ?? native.lastScanCount ?? 0;
    const checked = native.verifiedAt != null && native.verifiedCount != null;
    const out = base('ok', `${timeAgoFromIso(native.lastRunAt, now)} · ${countLabel(kind, count)}${checked ? ' · checked' : ''}`);
    out.checked = checked;
    out.count = count;
    out.lastBackupAt = native.lastRunAt;
    return out;
  }

  // Older data: a backup made before the run record existed, or by another
  // build. The manifest can say when and how many, never that this device is off.
  const syncAt = native?.lastUploadAt ?? manifest?.last_sync ?? null;
  if (syncAt) {
    const count = manifest?.last_sync && !native?.lastUploadAt
      ? manifest.items_synced ?? 0
      : native?.lastScanCount ?? manifest?.items_synced ?? 0;
    const out = base('ok', `${timeAgoFromIso(syncAt, now)}${count > 0 ? ` · ${countLabel(kind, count)}` : ''}`);
    out.lastBackupAt = syncAt;
    out.count = count > 0 ? count : null;
    return out;
  }

  return base('waiting', 'On · waiting for first backup');
}

// ── Previous backups ────────────────────────────────────────────────────────

export interface VersionLike {
  created_at: string;
  size_bytes: number;
}

export interface PreviousBackup {
  /** ISO time of the version (newest member when several files merged). */
  at: string;
  sizeBytes: number;
  /** Items in that backup when a stored run matches, otherwise null. */
  count: number | null;
}

/** Versions of different files made within this window are one backup run. */
const SAME_RUN_MS = 2 * 60_000;
/** A stored run belongs to a version made within this window before it ended. */
const RUN_MATCH_MS = 5 * 60_000;

/**
 * Build the "Previous backups" list from the version history the server keeps
 * (one array per file in the category folder), newest first. A count is shown
 * only when a locally stored run matches the version's time; otherwise the
 * caller shows the date and size.
 */
export function buildPreviousBackups(
  versionsPerFile: VersionLike[][],
  runs: CategoryRun[],
): PreviousBackup[] {
  const all = versionsPerFile
    .flat()
    .map((v) => ({ t: Date.parse(v.created_at), size: v.size_bytes }))
    .filter((v) => !Number.isNaN(v.t))
    .sort((a, b) => b.t - a.t);

  const groups: { newest: number; oldest: number; size: number }[] = [];
  for (const v of all) {
    const g = groups[groups.length - 1];
    if (g && g.oldest - v.t <= SAME_RUN_MS) {
      g.oldest = v.t;
      g.size += v.size;
    } else {
      groups.push({ newest: v.t, oldest: v.t, size: v.size });
    }
  }

  const parsedRuns = runs
    .map((r) => ({ t: Date.parse(r.at), count: r.count }))
    .filter((r) => !Number.isNaN(r.t));

  return groups.map((g) => {
    let best: { diff: number; count: number } | null = null;
    for (const r of parsedRuns) {
      // The run record is written when the run ends, after its uploads.
      const diff = Math.abs(r.t - g.newest);
      if (diff <= RUN_MATCH_MS && (!best || diff < best.diff)) best = { diff, count: r.count };
    }
    return { at: new Date(g.newest).toISOString(), sizeBytes: g.size, count: best ? best.count : null };
  });
}

export function formatPreviousBackup(entry: PreviousBackup, one: string, many: string): string {
  const d = new Date(entry.at);
  const date = Number.isNaN(d.getTime())
    ? 'Unknown date'
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (entry.count != null) {
    return `${date} · ${entry.count.toLocaleString('en-US')} ${entry.count === 1 ? one : many}`;
  }
  return `${date} · ${formatBytes(entry.sizeBytes)}`;
}
