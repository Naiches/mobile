// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  buildPreviousBackups,
  deriveCategoryBackupStatus,
  formatPreviousBackup,
} from './category-backup-status';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const idle = {
  lastScanAt: null,
  lastScanCount: 0,
  lastUploadAt: null,
  running: false,
  progressDone: 0,
  progressTotal: 0,
  permissionDenied: false,
  lastRunStatus: null,
  lastRunAt: null,
  lastError: null,
  verifiedCount: null,
  verifiedAt: null,
  runs: [],
};

describe('deriveCategoryBackupStatus: setting is the truth', () => {
  test('setting on with no manifest at all is not Off', () => {
    const s = deriveCategoryBackupStatus({ kind: 'contacts', settingEnabled: true, native: idle, manifest: null, now: NOW });
    expect(s.state).toBe('waiting');
    expect(s.text).not.toBe('Off');
    expect(s.text).toContain('waiting for first backup');
  });

  test('setting on with a manifest that says disabled is not Off', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'calendar',
      settingEnabled: true,
      native: null,
      manifest: { enabled: false, last_sync: null, items_synced: 0 },
      now: NOW,
    });
    expect(s.state).not.toBe('off');
    expect(s.text).not.toBe('Off');
  });

  test('setting off is Off even when the manifest says enabled', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: false,
      native: { ...idle, lastRunStatus: 'ok', lastRunAt: minutesAgo(3) },
      manifest: { enabled: true, last_sync: minutesAgo(3), items_synced: 9 },
      now: NOW,
    });
    expect(s.state).toBe('off');
    expect(s.text).toBe('Off');
  });

  test('manifest only fills in for older data, with no checked mark', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: true,
      native: null,
      manifest: { enabled: true, last_sync: minutesAgo(120), items_synced: 40 },
      now: NOW,
    });
    expect(s.state).toBe('ok');
    expect(s.text).toBe('2h ago · 40 contacts');
    expect(s.checked).toBe(false);
  });
});

describe('deriveCategoryBackupStatus: running, failed, verified', () => {
  test('running shows progress text and a fraction', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: true,
      native: { ...idle, running: true, progressDone: 340, progressTotal: 1234 },
      manifest: null,
      now: NOW,
    });
    expect(s.state).toBe('running');
    expect(s.text).toBe('Backing up contacts… 340 of 1,234');
    expect(s.fraction).toBeCloseTo(340 / 1234);
  });

  test('running with unknown total has no fraction', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'calendar',
      settingEnabled: true,
      native: { ...idle, running: true, progressDone: 0, progressTotal: 0 },
      manifest: null,
      now: NOW,
    });
    expect(s.text).toBe('Backing up calendar…');
    expect(s.fraction).toBeNull();
  });

  test('denied permission gives the plain error with Open Settings', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: true,
      native: { ...idle, permissionDenied: true },
      manifest: null,
      now: NOW,
    });
    expect(s.state).toBe('error');
    expect(s.text).toBe('No access to Contacts · Open Settings');
    expect(s.action).toBe('open_settings');
  });

  test('failed upload says so with Try again', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'calendar',
      settingEnabled: true,
      native: { ...idle, lastRunStatus: 'failed', lastError: 'upload_failed', lastRunAt: minutesAgo(1) },
      manifest: null,
      now: NOW,
    });
    expect(s.state).toBe('error');
    expect(s.text).toBe("Couldn't upload · Try again");
    expect(s.action).toBe('retry');
  });

  test('failed check says the previous backup was kept', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: true,
      native: { ...idle, lastRunStatus: 'failed', lastError: 'verify_failed', lastRunAt: minutesAgo(1) },
      manifest: null,
      now: NOW,
    });
    expect(s.state).toBe('error');
    expect(s.text).toContain('previous backup kept');
    expect(s.action).toBe('retry');
  });

  test('verified run shows time, count and checked', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: true,
      native: {
        ...idle,
        lastRunStatus: 'ok',
        lastRunAt: minutesAgo(5),
        lastUploadAt: minutesAgo(5),
        verifiedCount: 1234,
        verifiedAt: minutesAgo(5),
        lastScanCount: 1234,
      },
      manifest: null,
      now: NOW,
    });
    expect(s.state).toBe('ok');
    expect(s.text).toBe('5m ago · 1,234 contacts · checked');
    expect(s.checked).toBe(true);
    expect(s.count).toBe(1234);
  });

  test('singular event wording', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'calendar',
      settingEnabled: true,
      native: { ...idle, lastRunStatus: 'ok', lastRunAt: minutesAgo(0), verifiedCount: 1, verifiedAt: minutesAgo(0), lastScanCount: 1 },
      manifest: null,
      now: NOW,
    });
    expect(s.text).toBe('just now · 1 event · checked');
  });

  test('a later success clears an older failure', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: true,
      native: { ...idle, lastRunStatus: 'ok', lastError: 'upload_failed', lastRunAt: minutesAgo(2), verifiedCount: 3, verifiedAt: minutesAgo(2), lastScanCount: 3 },
      manifest: null,
      now: NOW,
    });
    expect(s.state).toBe('ok');
  });
});

describe('previous backups', () => {
  const v = (n: number, at: string, size: number) => ({
    id: `v${n}`, version_number: n, size_bytes: size, chunk_count: 1, created_at: at, source: 'object_version',
  });

  test('lists server versions newest first with the count when a run matches', () => {
    const list = buildPreviousBackups(
      [[v(1, minutesAgo(600), 1000), v(2, minutesAgo(300), 1200), v(3, minutesAgo(10), 1500)]],
      [
        { at: minutesAgo(599), count: 80, bytes: 1000 },
        { at: minutesAgo(9), count: 95, bytes: 1500 },
      ],
    );
    expect(list.map((e) => e.sizeBytes)).toEqual([1500, 1200, 1000]);
    expect(list[0].count).toBe(95);
    expect(list[1].count).toBeNull();
    expect(list[2].count).toBe(80);
  });

  test('falls back to date and size when no count is stored', () => {
    const [entry] = buildPreviousBackups([[v(1, minutesAgo(30), 2048)]], []);
    expect(entry.count).toBeNull();
    const label = formatPreviousBackup(entry, 'contact', 'contacts');
    expect(label).toContain('2 kB');
    expect(label).not.toContain('contacts');
  });

  test('label uses the count when known', () => {
    const [entry] = buildPreviousBackups([[v(1, minutesAgo(30), 2048)]], [{ at: minutesAgo(30), count: 1, bytes: 2048 }]);
    expect(formatPreviousBackup(entry, 'contact', 'contacts')).toContain('1 contact');
  });

  test('versions of several files made in one run merge into one entry', () => {
    const list = buildPreviousBackups(
      [
        [v(1, minutesAgo(20), 100)],
        [v(1, new Date(NOW - 20 * 60_000 + 4_000).toISOString(), 300)],
      ],
      [{ at: minutesAgo(20), count: 12, bytes: 400 }],
    );
    expect(list.length).toBe(1);
    expect(list[0].sizeBytes).toBe(400);
    expect(list[0].count).toBe(12);
  });

  test('no versions gives an empty list', () => {
    expect(buildPreviousBackups([], [])).toEqual([]);
    expect(buildPreviousBackups([[]], [])).toEqual([]);
  });
});

describe('deriveCategoryBackupStatus: incomplete exports and limited access', () => {
  test('an incomplete export keeps the last good backup and says so', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: true,
      native: { ...idle, lastRunStatus: 'failed', lastError: 'incomplete_export', lastRunAt: minutesAgo(1), lastUploadAt: minutesAgo(600), verifiedCount: 1234, refusedCount: 312 },
      manifest: null,
      now: NOW,
    });
    expect(s.state).toBe('error');
    expect(s.text).toBe('Contacts look incomplete on this iPhone; the last good backup was kept · Back up anyway');
    expect(s.action).toBe('backup_anyway');
    expect(s.lastBackupAt).toBe(minutesAgo(600));
  });

  test('Back up anyway asks once, naming both counts and the 30 days', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: true,
      native: { ...idle, lastRunStatus: 'failed', lastError: 'incomplete_export', lastRunAt: minutesAgo(1), verifiedCount: 1234, refusedCount: 312 },
      manifest: null,
      now: NOW,
    });
    expect(s.confirmText).toBe('Replace your last backup (1,234 contacts) with this one (312 contacts)? Earlier versions stay available for 30 days.');
  });

  test('calendar confirmation uses events and handles single items', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'calendar',
      settingEnabled: true,
      native: { ...idle, lastRunStatus: 'failed', lastError: 'incomplete_export', lastRunAt: minutesAgo(1), verifiedCount: 40, refusedCount: 1 },
      manifest: null,
      now: NOW,
    });
    expect(s.action).toBe('backup_anyway');
    expect(s.confirmText).toBe('Replace your last backup (40 events) with this one (1 event)? Earlier versions stay available for 30 days.');
  });

  test('without the counts there is no Back up anyway', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: true,
      native: { ...idle, lastRunStatus: 'failed', lastError: 'incomplete_export', lastRunAt: minutesAgo(1) },
      manifest: null,
      now: NOW,
    });
    expect(s.action).toBeNull();
    expect(s.confirmText).toBeNull();
  });

  test('limited access never offers Back up anyway', () => {
    for (const native of [
      { ...idle, limitedAccess: true, verifiedCount: 10, refusedCount: 2 },
      { ...idle, lastRunStatus: 'failed', lastError: 'limited_access', verifiedCount: 10, refusedCount: 2 },
    ]) {
      const s = deriveCategoryBackupStatus({ kind: 'contacts', settingEnabled: true, native, manifest: null, now: NOW });
      expect(s.action).toBe('open_settings');
      expect(s.confirmText).toBeNull();
    }
  });

  test('a failed check of the existing backup says nothing was uploaded and offers a retry', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: true,
      native: { ...idle, lastRunStatus: 'failed', lastError: 'baseline_unavailable', lastRunAt: minutesAgo(1) },
      manifest: null,
      now: NOW,
    });
    expect(s.state).toBe('error');
    expect(s.text).toBe("Couldn't check your existing backup, nothing was uploaded · Try again");
    expect(s.action).toBe('retry');
  });

  test('an empty first export is waiting, not an error, and never offers Back up anyway', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'calendar',
      settingEnabled: true,
      native: { ...idle, lastRunStatus: 'failed', lastError: 'nothing_to_back_up', lastRunAt: minutesAgo(1) },
      manifest: null,
      now: NOW,
    });
    expect(s.state).toBe('waiting');
    expect(s.text).toBe('No events to back up yet');
    expect(s.action).toBeNull();
  });

  test('calendar uses its own words for an incomplete export', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'calendar',
      settingEnabled: true,
      native: { ...idle, lastRunStatus: 'failed', lastError: 'incomplete_export', lastRunAt: minutesAgo(1) },
      manifest: null,
      now: NOW,
    });
    expect(s.text).toBe('Calendar looks incomplete on this iPhone; the last good backup was kept');
    expect(s.action).toBeNull();
  });

  test('limited access is its own state with Open Settings', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: true,
      native: { ...idle, limitedAccess: true },
      manifest: null,
      now: NOW,
    });
    expect(s.state).toBe('error');
    expect(s.text).toBe('Beebeeb can only see some contacts. Allow full access to back up all of them');
    expect(s.action).toBe('open_settings');
  });

  test('a stored limited_access failure shows the same state', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: true,
      native: { ...idle, lastRunStatus: 'failed', lastError: 'limited_access', lastRunAt: minutesAgo(1) },
      manifest: null,
      now: NOW,
    });
    expect(s.text).toBe('Beebeeb can only see some contacts. Allow full access to back up all of them');
    expect(s.action).toBe('open_settings');
  });

  test('denied access wins over limited access', () => {
    const s = deriveCategoryBackupStatus({
      kind: 'contacts',
      settingEnabled: true,
      native: { ...idle, permissionDenied: true, limitedAccess: true },
      manifest: null,
      now: NOW,
    });
    expect(s.text).toContain('No access to Contacts');
  });
});
