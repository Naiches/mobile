import Foundation
import CryptoKit

/// Synchronous admission result for a Contacts or Calendar backup request.
/// The Expo bridge returns the raw value so JS can distinguish a real start
/// from every deliberate native no-op.
enum CategoryBackupRunAdmission: String, CaseIterable {
  case started
  case alreadyRunning = "already_running"
  case notBound = "not_bound"
  case accountRefused = "account_refused"
}

/// Stable identity for one EventKit calendar. Display titles are neither
/// unique nor stable (two accounts commonly both contain "Calendar"), so
/// ledger/dedup keys and the uploaded filename use EventKit's identifier.
/// The human-readable title remains inside the ICS as X-WR-CALNAME; keeping it
/// out of the filename means a rename cannot start a second backup lineage.
struct CalendarBackupIdentity: Equatable {
  /// Bump when the persisted key/filename projection changes. A successful
  /// Calendar run records this per account; older installs run once to migrate.
  static let currentVersion = 1

  let itemKey: String
  let fileName: String

  init(accountId: String, calendarIdentifier: String) {
    let accountDigest = Self.digest("\(accountId)\u{0}\(calendarIdentifier)")
    let calendarDigest = Self.digest(calendarIdentifier)
    self.itemKey = accountDigest
    self.fileName = "Calendar--\(calendarDigest).ics"
  }

  static func requiresMigration(storedVersion: Int?) -> Bool {
    (storedVersion ?? 0) < currentVersion
  }

  private static func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

/// Task 1589 — recognizing a swept v2 upload session from the native (Swift)
/// upload paths (`NativeBackupEngine.swift`, `NativeManualUploader.swift`).
///
/// Server PR #120 gives every v2 upload session a lease (default 3600 s,
/// renewed by every chunk request, the complete call and an explicit
/// heartbeat). Once the lease expires and the sweeper reclaims the session,
/// every later chunk PUT, complete or heartbeat against it answers 404 — "one
/// code for a swept session" (`beebeeb-api/src/routes/uploads.rs`,
/// `load_upload_session`). An older server (pre-#120, or mid-rolling-deploy)
/// can still answer 400 `"upload session is not writable: expired"` for the
/// exact same condition, so that is matched too, as a fallback.
///
/// Mirrors the mobile JS `isUploadSessionGone` (`src/lib/upload-session-
/// reinit.ts`, PR-1589) and the CLI's identically-purposed check (PR #50) —
/// same two signals, so every client that keys a request on a persisted v2
/// `upload_session_id` tells the same story about a swept upload.
///
/// Deliberately free of every other type in this module (no `BackupError`,
/// no `NativeUploadFailure`) so it stays trivially unit-testable — see
/// `.claude/tasks/_qa-evidence/1589/mobile-swift-test/` for the standalone
/// `swiftc` harness that compiles this exact file.
func isUploadSessionGoneStatus(_ status: Int, body: String) -> Bool {
  if status == 404 { return true }
  if status == 400 {
    let lowered = body.lowercased()
    return lowered.contains("not writable") && lowered.contains("expired")
  }
  return false
}

/// Runs callback-based asynchronous work one item at a time. `start` must call
/// its continuation when that item settles; the next item starts then, without
/// blocking the thread that started the pipeline. A repeated continuation is
/// ignored so a faulty callback cannot start two items or finish twice.
enum AsyncSerialPipeline {
  static func forEach<Element>(
    _ elements: [Element],
    start: @escaping (Element, @escaping () -> Void) -> Void,
    completion: @escaping () -> Void
  ) {
    func advance(to index: Int) {
      guard index < elements.count else {
        completion()
        return
      }

      let lock = NSLock()
      var didAdvance = false
      start(elements[index]) {
        lock.lock()
        guard !didAdvance else {
          lock.unlock()
          return
        }
        didAdvance = true
        lock.unlock()
        advance(to: index + 1)
      }
    }

    advance(to: 0)
  }
}

// MARK: - Contacts and Calendar backup: verify the export, keep the last run
//
// Lives in this small Foundation-only file so the standalone swiftc harness
// (scripts/swift-tests/backup-export-verification-test.swift) can compile it
// without the rest of the module.

/// Parses an exported vCard / iCalendar file back and counts its entries. A
/// backup is uploaded only when the count equals the number exported; a
/// truncated or malformed file never replaces a good backup.
enum BackupExportVerification {
  struct Outcome: Equatable {
    let ok: Bool
    let count: Int
    let reason: String?
  }

  /// RFC 5545 / RFC 6350 unfolding: a line starting with a space or tab
  /// continues the previous one. Returns the logical lines.
  static func logicalLines(_ text: String) -> [String] {
    var out: [String] = []
    for raw in text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" }) {
      let line = raw.hasSuffix("\r") ? String(raw.dropLast()) : String(raw)
      if let first = line.first, (first == " " || first == "\t"), !out.isEmpty {
        out[out.count - 1] += String(line.dropFirst())
      } else {
        out.append(line)
      }
    }
    return out
  }

  /// Number of complete vCards, or nil when the data is not a well-formed
  /// sequence of vCards (bad encoding, nesting, a card left open, a card
  /// with no VERSION line). Empty data is zero cards.
  static func countVCards(_ data: Data) -> Int? {
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    var count = 0
    var inside = false
    var hasVersion = false
    for line in logicalLines(text) {
      let upper = line.uppercased()
      if upper == "BEGIN:VCARD" {
        if inside { return nil }
        inside = true
        hasVersion = false
      } else if upper == "END:VCARD" {
        if !inside || !hasVersion { return nil }
        inside = false
        count += 1
      } else if inside, upper.hasPrefix("VERSION:") {
        hasVersion = true
      } else if !inside, !line.trimmingCharacters(in: .whitespaces).isEmpty {
        return nil
      }
    }
    return inside ? nil : count
  }

  /// Number of complete VEVENTs inside one VCALENDAR, or nil when the file is
  /// not a well-formed calendar (no wrapper, wrapper not closed, an event left
  /// open or without UID and DTSTART).
  static func countICalEvents(_ data: Data) -> Int? {
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    var sawBegin = false
    var sawEnd = false
    var inEvent = false
    var hasUID = false
    var hasStart = false
    var count = 0
    for line in logicalLines(text) {
      let upper = line.uppercased()
      if upper == "BEGIN:VCALENDAR" {
        if sawBegin { return nil }
        sawBegin = true
      } else if upper == "END:VCALENDAR" {
        if !sawBegin || inEvent || sawEnd { return nil }
        sawEnd = true
      } else if upper == "BEGIN:VEVENT" {
        if !sawBegin || sawEnd || inEvent { return nil }
        inEvent = true
        hasUID = false
        hasStart = false
      } else if upper == "END:VEVENT" {
        if !inEvent || !hasUID || !hasStart { return nil }
        inEvent = false
        count += 1
      } else if inEvent {
        if upper.hasPrefix("UID:") { hasUID = true }
        if upper.hasPrefix("DTSTART") { hasStart = true }
      }
    }
    return (sawBegin && sawEnd && !inEvent) ? count : nil
  }

  static func verifyVCards(_ data: Data, expected: Int) -> Outcome {
    guard let found = countVCards(data) else {
      return Outcome(ok: false, count: 0, reason: "parse_failed")
    }
    return found == expected
      ? Outcome(ok: true, count: found, reason: nil)
      : Outcome(ok: false, count: found, reason: "count_mismatch")
  }

  static func verifyICal(_ data: Data, expected: Int) -> Outcome {
    guard let found = countICalEvents(data) else {
      return Outcome(ok: false, count: 0, reason: "parse_failed")
    }
    return found == expected
      ? Outcome(ok: true, count: found, reason: nil)
      : Outcome(ok: false, count: found, reason: "count_mismatch")
  }

  /// A verified export can still be a worse one than the backup it would
  /// replace (the OS returned no contacts, or only some). Returns
  /// `incomplete_export` when the new count is zero while the last verified
  /// backup had items, or below half of it; nil otherwise (including the first
  /// backup, when nothing is known). `force` is the user's one-time "back up
  /// anyway": it skips this rule only, never verification.
  static func incompleteReason(count: Int, lastVerified: Int?, force: Bool = false) -> String? {
    if force { return nil }
    guard let last = lastVerified, last > 0 else { return nil }
    if count == 0 || count * 2 < last { return "incomplete_export" }
    return nil
  }

  /// What the account already holds for one backup file.
  enum ServerBaseline: Equatable {
    /// The current backup parsed to this many entries.
    case count(Int)
    /// The account has no backup of this file.
    case noBackup
    /// The lookup or download failed, or the backup would not parse.
    case unavailable
  }

  enum ExportGate: Equatable {
    /// Go ahead. `baselineToStore` is the count taken from the server (nil when
    /// the device already had one, or none was needed).
    case proceed(baselineToStore: Int?)
    /// Do not upload this run. `code` is the status code to record.
    case refuse(code: String, refusedCount: Int?, baselineToStore: Int? = nil)
  }

  /// Decides whether an export may replace the backup on the server. The
  /// baseline is the device's verified count when it has one; otherwise the
  /// server copy is asked for (`serverBaseline` runs only then, and only
  /// when the answer matters). With no baseline of either kind an empty export
  /// is never uploaded as a first backup. `force` is the user's "back up anyway".
  static func gate(
    count: Int,
    localBaseline: Int?,
    force: Bool,
    serverBaseline: () -> ServerBaseline
  ) -> ExportGate {
    if force { return .proceed(baselineToStore: nil) }
    if localBaseline != nil {
      if let reason = incompleteReason(count: count, lastVerified: localBaseline) {
        return .refuse(code: reason, refusedCount: count)
      }
      return .proceed(baselineToStore: nil)
    }
    switch serverBaseline() {
    case .unavailable:
      return .refuse(code: "baseline_unavailable", refusedCount: nil)
    case .noBackup:
      return count == 0
        ? .refuse(code: "nothing_to_back_up", refusedCount: nil)
        : .proceed(baselineToStore: nil)
    case .count(let known):
      if let reason = incompleteReason(count: count, lastVerified: known) {
        return .refuse(code: reason, refusedCount: count, baselineToStore: known)
      }
      return .proceed(baselineToStore: known)
    }
  }

  struct ListingEntry: Equatable {
    let id: String
    let nameEncrypted: String
    let isFolder: Bool
    let isUploading: Bool
    let updatedAt: String
    let sizeBytes: Int
  }

  /// One page of `GET /api/v1/files?parent_id=...`.
  static func parseListing(_ data: Data) -> (entries: [ListingEntry], nextCursor: String?)? {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let files = root["files"] as? [[String: Any]] else { return nil }
    let entries = files.compactMap { f -> ListingEntry? in
      guard let id = f["id"] as? String, let name = f["name_encrypted"] as? String else { return nil }
      return ListingEntry(
        id: id,
        nameEncrypted: name,
        isFolder: f["is_folder"] as? Bool ?? false,
        isUploading: f["is_uploading"] as? Bool ?? false,
        updatedAt: f["updated_at"] as? String ?? "",
        sizeBytes: (f["size_bytes"] as? NSNumber)?.intValue ?? 0
      )
    }
    let cursor = root["next_cursor"] as? String
    return (entries, (cursor?.isEmpty ?? true) ? nil : cursor)
  }

  /// The newest finished file called `fileName`. `names[i]` is the decrypted
  /// name of `entries[i]` (nil when it could not be decrypted).
  static func newestEntry(named fileName: String, entries: [ListingEntry], names: [String?]) -> ListingEntry? {
    var best: ListingEntry?
    for (index, entry) in entries.enumerated() where index < names.count {
      guard !entry.isFolder, !entry.isUploading, names[index] == fileName else { continue }
      if let current = best, current.updatedAt >= entry.updatedAt { continue }
      best = entry
    }
    return best
  }

  /// The only path from an export to an upload: `upload` runs when, and only
  /// when, the outcome is verified. Returns whether it ran.
  @discardableResult
  static func uploadIfVerified(_ outcome: Outcome, upload: () -> Void) -> Bool {
    guard outcome.ok else { return false }
    upload()
    return true
  }
}

/// Persisted record of a category's last runs (Contacts or Calendar). A failed
/// run records the failure and touches nothing else, so the last good backup's
/// time, count and run history stay as they were.
struct CategoryRunLedger {
  let defaults: UserDefaults
  let prefix: String
  static let maxRuns = 10

  private func key(_ name: String) -> String { prefix + name }

  /// `uploaded` is false when the verified export matched what is already
  /// backed up (no new version on the server).
  func recordSuccess(count: Int, bytes: Int, uploaded: Bool, at date: Date = Date()) {
    let stamp = ISO8601DateFormatter().string(from: date)
    defaults.set("ok", forKey: key("LastRunStatus"))
    defaults.set(stamp, forKey: key("LastRunAt"))
    defaults.removeObject(forKey: key("LastError"))
    defaults.removeObject(forKey: key("RefusedCount"))
    defaults.set(count, forKey: key("VerifiedCount"))
    defaults.set(stamp, forKey: key("VerifiedAt"))
    guard uploaded else { return }
    var runs = loadRuns()
    runs.append(["at": stamp, "count": count, "bytes": bytes])
    if runs.count > Self.maxRuns { runs.removeFirst(runs.count - Self.maxRuns) }
    if let data = try? JSONSerialization.data(withJSONObject: runs) {
      defaults.set(data, forKey: key("Runs"))
    }
  }

  func recordFailure(code: String, refusedCount: Int? = nil, at date: Date = Date()) {
    if let refusedCount {
      defaults.set(refusedCount, forKey: key("RefusedCount"))
    } else {
      defaults.removeObject(forKey: key("RefusedCount"))
    }
    defaults.set("failed", forKey: key("LastRunStatus"))
    defaults.set(ISO8601DateFormatter().string(from: date), forKey: key("LastRunAt"))
    defaults.set(code, forKey: key("LastError"))
  }

  /// Items counted in the last verified backup, nil when none is recorded.
  var lastVerifiedCount: Int? {
    defaults.object(forKey: key("VerifiedCount")) as? Int
  }

  /// Verified entry count of one item inside the category (a calendar), keyed
  /// by the caller's per-item state key. nil when none is recorded.
  func itemCount(for itemKey: String) -> Int? {
    (defaults.dictionary(forKey: key("ItemCounts")) as? [String: Int])?[itemKey]
  }

  func setItemCount(_ count: Int, for itemKey: String) {
    var all = (defaults.dictionary(forKey: key("ItemCounts")) as? [String: Int]) ?? [:]
    all[itemKey] = count
    defaults.set(all, forKey: key("ItemCounts"))
  }

  /// Records a count taken from the server as the category's baseline.
  func setVerifiedCount(_ count: Int) {
    defaults.set(count, forKey: key("VerifiedCount"))
  }

  func loadRuns() -> [[String: Any]] {
    guard let data = defaults.data(forKey: key("Runs")),
          let any = try? JSONSerialization.jsonObject(with: data),
          let runs = any as? [[String: Any]] else { return [] }
    return runs
  }

  func fields() -> [String: Any] {
    [
      "lastRunStatus": defaults.string(forKey: key("LastRunStatus")) as Any? ?? NSNull(),
      "lastRunAt": defaults.string(forKey: key("LastRunAt")) as Any? ?? NSNull(),
      "lastError": defaults.string(forKey: key("LastError")) as Any? ?? NSNull(),
      "verifiedCount": defaults.object(forKey: key("VerifiedCount")) as Any? ?? NSNull(),
      "verifiedAt": defaults.string(forKey: key("VerifiedAt")) as Any? ?? NSNull(),
      "refusedCount": defaults.object(forKey: key("RefusedCount")) as Any? ?? NSNull(),
      "runs": loadRuns(),
    ]
  }

  func reset() {
    for name in ["LastRunStatus", "LastRunAt", "LastError", "VerifiedCount", "VerifiedAt", "RefusedCount", "Runs", "ItemCounts"] {
      defaults.removeObject(forKey: key(name))
    }
  }
}
