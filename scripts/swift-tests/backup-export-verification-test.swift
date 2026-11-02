import Foundation

// Contacts and Calendar backup: the exported file is parsed back and its entry
// count must equal what was exported, or nothing is uploaded and the previous
// backup stays. Fixtures are generated here, never real data.

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else { print("FAIL: \(name)"); exit(1) }
    assertions += 1
    print("PASS: \(name)")
}

func makeVCards(_ n: Int) -> String {
    (0..<n).map { i in
        "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Person\(i);Test;;;\r\nFN:Test Person\(i)\r\nTEL;type=CELL:+1555000\(1000 + i)\r\nEND:VCARD\r\n"
    }.joined()
}

func makeICal(_ n: Int) -> String {
    var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN"]
    for i in 0..<n {
        lines += ["BEGIN:VEVENT", "UID:event-\(i)@test", "DTSTAMP:20260101T000000Z",
                  "DTSTART:20260102T0900\(String(format: "%02d", i % 60))Z", "SUMMARY:Event \(i)", "END:VEVENT"]
    }
    lines.append("END:VCALENDAR")
    return lines.joined(separator: "\r\n")
}

// ── vCard ──
let cards = Data(makeVCards(5).utf8)
check(BackupExportVerification.countVCards(cards) == 5, "valid vCards are counted")
check(BackupExportVerification.verifyVCards(cards, expected: 5).ok, "matching vCard count verifies")
let wrongCount = BackupExportVerification.verifyVCards(cards, expected: 6)
check(!wrongCount.ok && wrongCount.reason == "count_mismatch", "a vCard count mismatch fails")
check(BackupExportVerification.verifyVCards(Data(), expected: 0).ok, "no contacts verifies as zero")

let truncatedCards = Data(makeVCards(5).utf8.dropLast(40))
check(BackupExportVerification.countVCards(truncatedCards) == nil, "a truncated vCard file does not parse")
let truncatedOutcome = BackupExportVerification.verifyVCards(truncatedCards, expected: 5)
check(!truncatedOutcome.ok && truncatedOutcome.reason == "parse_failed", "a truncated vCard file fails")
check(BackupExportVerification.countVCards(Data("BEGIN:VCARD\r\nFN:No Version\r\nEND:VCARD\r\n".utf8)) == nil,
      "a card without VERSION is malformed")
check(BackupExportVerification.countVCards(Data("garbage".utf8)) == nil, "stray text is malformed")
check(BackupExportVerification.countVCards(Data([0xff, 0xfe, 0x00])) == nil, "non-UTF-8 is malformed")

let folded = Data("BEGIN:VCARD\r\nVERSION:3.0\r\nNOTE:a long\r\n  folded line\r\nEND:VCARD\r\n".utf8)
check(BackupExportVerification.countVCards(folded) == 1, "folded lines are unfolded")

// ── iCalendar ──
let ical = Data(makeICal(4).utf8)
check(BackupExportVerification.countICalEvents(ical) == 4, "valid iCalendar events are counted")
check(BackupExportVerification.verifyICal(ical, expected: 4).ok, "matching event count verifies")
check(!BackupExportVerification.verifyICal(ical, expected: 3).ok, "an event count mismatch fails")

let truncatedIcal = Data(makeICal(4).utf8.dropLast(30))
check(BackupExportVerification.countICalEvents(truncatedIcal) == nil, "a truncated iCalendar file does not parse")
check(BackupExportVerification.verifyICal(truncatedIcal, expected: 4).reason == "parse_failed", "a truncated iCalendar file fails")
let noWrapper = Data("BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260102T090000Z\r\nEND:VEVENT\r\n".utf8)
check(BackupExportVerification.countICalEvents(noWrapper) == nil, "an event outside a calendar is malformed")
let noUID = Data("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260102T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n".utf8)
check(BackupExportVerification.countICalEvents(noUID) == nil, "an event without UID is malformed")

// ── the previous backup is kept ──
var uploads = 0
check(BackupExportVerification.uploadIfVerified(BackupExportVerification.verifyVCards(cards, expected: 5)) { uploads += 1 },
      "a verified export is uploaded")
check(uploads == 1, "upload ran once for the good export")
check(!BackupExportVerification.uploadIfVerified(truncatedOutcome) { uploads += 1 }, "a broken export is not uploaded")
check(uploads == 1, "the upload did not run for the broken export")

// ── run ledger ──
let suite = "bb-run-ledger-test-\(UUID().uuidString)"
let defaults = UserDefaults(suiteName: suite)!
defer { defaults.removePersistentDomain(forName: suite) }
let ledger = CategoryRunLedger(defaults: defaults, prefix: "test.contacts.")
check(ledger.fields()["lastRunStatus"] is NSNull, "a new ledger has no run")

ledger.recordSuccess(count: 12, bytes: 900, uploaded: true, at: Date(timeIntervalSince1970: 1_000))
var f = ledger.fields()
check(f["lastRunStatus"] as? String == "ok", "success is recorded")
check(f["verifiedCount"] as? Int == 12, "the verified count is stored")
check((f["runs"] as? [[String: Any]])?.count == 1, "an uploaded run is added to the history")

ledger.recordFailure(code: "verify_failed", at: Date(timeIntervalSince1970: 2_000))
f = ledger.fields()
check(f["lastRunStatus"] as? String == "failed", "a failed run is recorded")
check(f["lastError"] as? String == "verify_failed", "the failure code is stored")
check(f["verifiedCount"] as? Int == 12, "a failed run keeps the last good verified count")
check((f["runs"] as? [[String: Any]])?.count == 1, "a failed run adds nothing to the history")

ledger.recordSuccess(count: 12, bytes: 900, uploaded: false, at: Date(timeIntervalSince1970: 3_000))
f = ledger.fields()
check(f["lastError"] is NSNull, "a later success clears the failure")
check((f["runs"] as? [[String: Any]])?.count == 1, "an unchanged export adds no history entry")

for i in 0..<15 { ledger.recordSuccess(count: i, bytes: 1, uploaded: true) }
check((ledger.fields()["runs"] as? [[String: Any]])?.count == CategoryRunLedger.maxRuns, "the history is capped")
ledger.reset()
check(ledger.fields()["lastRunStatus"] is NSNull, "reset clears the ledger")

// ── a worse export never replaces a good backup ──
check(BackupExportVerification.incompleteReason(count: 0, lastVerified: 120) == "incomplete_export", "an empty export after a good backup is refused")
check(BackupExportVerification.incompleteReason(count: 59, lastVerified: 120) == "incomplete_export", "a drop below half is refused")
check(BackupExportVerification.incompleteReason(count: 60, lastVerified: 120) == nil, "exactly half is allowed")
check(BackupExportVerification.incompleteReason(count: 119, lastVerified: 120) == nil, "a small drop is allowed")
check(BackupExportVerification.incompleteReason(count: 0, lastVerified: 0) == nil, "empty after an empty backup is allowed")
check(BackupExportVerification.incompleteReason(count: 0, lastVerified: nil) == nil, "the first backup is never refused")
check(BackupExportVerification.incompleteReason(count: 2, lastVerified: 3) == nil, "2 of 3 is above half")
check(BackupExportVerification.incompleteReason(count: 1, lastVerified: 3) == "incomplete_export", "1 of 3 is below half")
check(BackupExportVerification.incompleteReason(count: 2, lastVerified: 4) == nil, "2 of 4 is exactly half")
check(BackupExportVerification.incompleteReason(count: 1, lastVerified: 5) == "incomplete_export", "1 of 5 is below half")
check(BackupExportVerification.incompleteReason(count: 500, lastVerified: 120) == nil, "growth is allowed")

let guardSuite = "bb-guard-ledger-\(UUID().uuidString)"
let guardDefaults = UserDefaults(suiteName: guardSuite)!
defer { guardDefaults.removePersistentDomain(forName: guardSuite) }
let guardLedger = CategoryRunLedger(defaults: guardDefaults, prefix: "test.guard.")
check(guardLedger.lastVerifiedCount == nil, "a new ledger has no verified count")
guardLedger.recordSuccess(count: 120, bytes: 1, uploaded: true)
check(guardLedger.lastVerifiedCount == 120, "the ledger exposes the last verified count")
guardLedger.recordFailure(code: "incomplete_export")
check(guardLedger.lastVerifiedCount == 120, "a refused run keeps the verified count")
check(guardLedger.fields()["lastError"] as? String == "incomplete_export", "the refusal code is stored")
check(BackupExportVerification.incompleteReason(count: 0, lastVerified: guardLedger.lastVerifiedCount) == "incomplete_export",
      "the ledger count drives the refusal")

// ── Back up anyway: one forced run skips the drop rule only ──
check(BackupExportVerification.incompleteReason(count: 0, lastVerified: 120, force: true) == nil, "a forced run skips the empty-export rule")
check(BackupExportVerification.incompleteReason(count: 10, lastVerified: 120, force: true) == nil, "a forced run skips the drop rule")
check(BackupExportVerification.incompleteReason(count: 10, lastVerified: 120, force: false) == "incomplete_export", "an unforced run still refuses")
check(!BackupExportVerification.verifyVCards(truncatedCards, expected: 5).ok, "a forced run still fails verification on a broken file")
check(!BackupExportVerification.uploadIfVerified(truncatedOutcome) { uploads += 1 }, "a broken file is not uploaded even when forced")

let anyDefaults = UserDefaults(suiteName: guardSuite)!
let anyLedger = CategoryRunLedger(defaults: anyDefaults, prefix: "test.anyway.")
anyLedger.recordSuccess(count: 1234, bytes: 1, uploaded: true)
anyLedger.recordFailure(code: "incomplete_export", refusedCount: 312)
var af = anyLedger.fields()
check(af["refusedCount"] as? Int == 312, "a refusal stores the count it saw")
check(af["verifiedCount"] as? Int == 1234, "a refusal keeps the verified count")
anyLedger.recordSuccess(count: 312, bytes: 1, uploaded: true)
af = anyLedger.fields()
check(af["refusedCount"] is NSNull, "a success clears the refused count")
check(anyLedger.lastVerifiedCount == 312, "the new count becomes the baseline")
check(BackupExportVerification.incompleteReason(count: 300, lastVerified: anyLedger.lastVerifiedCount) == nil, "the next run compares against the new baseline")
anyLedger.recordFailure(code: "incomplete_export", refusedCount: 5)
anyLedger.recordFailure(code: "upload_failed")
check(anyLedger.fields()["refusedCount"] is NSNull, "a different failure clears the refused count")
anyLedger.recordFailure(code: "incomplete_export", refusedCount: 5)
anyLedger.reset()
check(anyLedger.fields()["refusedCount"] is NSNull, "reset clears the refused count")

// ── baseline from the server when the device has none ──
var lookups = 0
func server(_ b: BackupExportVerification.ServerBaseline) -> () -> BackupExportVerification.ServerBaseline {
    { lookups += 1; return b }
}
typealias Gate = BackupExportVerification.ExportGate

check(BackupExportVerification.gate(count: 0, localBaseline: 100, force: false, serverBaseline: server(.noBackup))
      == .refuse(code: "incomplete_export", refusedCount: 0), "a local baseline refuses an empty export")
check(lookups == 0, "a local baseline needs no server lookup")
check(BackupExportVerification.gate(count: 0, localBaseline: nil, force: false, serverBaseline: server(.count(300)))
      == .refuse(code: "incomplete_export", refusedCount: 0, baselineToStore: 300), "no local baseline: an empty export is refused against the server copy")
check(BackupExportVerification.gate(count: 100, localBaseline: nil, force: false, serverBaseline: server(.count(300)))
      == .refuse(code: "incomplete_export", refusedCount: 100, baselineToStore: 300), "no local baseline: under half of the server copy is refused")
check(BackupExportVerification.gate(count: 150, localBaseline: nil, force: false, serverBaseline: server(.count(300)))
      == .proceed(baselineToStore: 300), "no local baseline: half of the server copy proceeds and stores the baseline")
check(BackupExportVerification.gate(count: 40, localBaseline: nil, force: false, serverBaseline: server(.unavailable))
      == .refuse(code: "baseline_unavailable", refusedCount: nil), "a failed download refuses the run")
check(BackupExportVerification.gate(count: 40, localBaseline: nil, force: false, serverBaseline: server(.noBackup))
      == .proceed(baselineToStore: nil), "no server backup: the first backup uploads")
check(BackupExportVerification.gate(count: 0, localBaseline: nil, force: false, serverBaseline: server(.noBackup))
      == .refuse(code: "nothing_to_back_up", refusedCount: nil), "an empty first backup is never uploaded")
lookups = 0
check(BackupExportVerification.gate(count: 0, localBaseline: nil, force: true, serverBaseline: server(.unavailable))
      == .proceed(baselineToStore: nil), "back up anyway skips the rule")
check(lookups == 0, "back up anyway makes no lookup")
check(BackupExportVerification.gate(count: 5, localBaseline: 0, force: false, serverBaseline: server(.count(300)))
      == .proceed(baselineToStore: nil), "a recorded empty baseline is a baseline")

// ── listing ──
let listing = Data("""
{"files":[
 {"id":"a","name_encrypted":"n1","is_folder":false,"updated_at":"2026-01-01T00:00:00Z","size_bytes":10},
 {"id":"b","name_encrypted":"n2","is_folder":false,"updated_at":"2026-02-01T00:00:00Z","size_bytes":20},
 {"id":"c","name_encrypted":"n3","is_folder":false,"is_uploading":true,"updated_at":"2026-03-01T00:00:00Z","size_bytes":5},
 {"id":"d","name_encrypted":"n4","is_folder":true,"updated_at":"2026-04-01T00:00:00Z","size_bytes":0}
],"next_cursor":"abc"}
""".utf8)
let parsed = BackupExportVerification.parseListing(listing)
check(parsed?.entries.count == 4 && parsed?.nextCursor == "abc", "a listing page parses with its cursor")
check(BackupExportVerification.parseListing(Data("{}".utf8)) == nil, "a listing without files is rejected")
let picked = BackupExportVerification.newestEntry(named: "contacts.vcf", entries: parsed!.entries,
                                                  names: ["contacts.vcf", "contacts.vcf", "contacts.vcf", "contacts.vcf"])
check(picked?.id == "b", "the newest finished file of that name is picked (not uploading, not a folder)")
check(BackupExportVerification.newestEntry(named: "x.ics", entries: parsed!.entries, names: ["a", nil, "b", "c"]) == nil,
      "no match gives nil")

// ── serial asynchronous work ──
// Calendar uploads must stay one-at-a-time without parking the background GCD
// worker while an upload is in flight. Hold each continuation here: returning
// from `forEach` with only the first item started proves the caller is not
// blocked waiting for it.
var serialStarted: [Int] = []
var serialContinuations: [() -> Void] = []
var serialFinished = 0
AsyncSerialPipeline.forEach(
    [1, 2, 3],
    start: { item, next in
        serialStarted.append(item)
        serialContinuations.append(next)
    },
    completion: { serialFinished += 1 }
)
check(serialStarted == [1], "the serial pipeline returns with only its first item started")
check(serialFinished == 0, "the serial pipeline does not finish before the first callback")

let firstContinuation = serialContinuations.removeFirst()
firstContinuation()
firstContinuation()
check(serialStarted == [1, 2], "one completion starts exactly one next item")

// A failed calendar upload uses the same continuation as a success. The
// pipeline must keep going so one failure does not suppress later calendars.
let failedContinuation = serialContinuations.removeFirst()
failedContinuation()
check(serialStarted == [1, 2, 3], "the pipeline can continue after a failed operation")
check(serialFinished == 0, "the pipeline waits for the last operation")

let lastContinuation = serialContinuations.removeFirst()
lastContinuation()
lastContinuation()
check(serialFinished == 1, "the serial pipeline finishes exactly once")

var emptyFinished = 0
AsyncSerialPipeline.forEach([Int](), start: { _, _ in
    check(false, "an empty pipeline starts no work")
}, completion: { emptyFinished += 1 })
check(emptyFinished == 1, "an empty serial pipeline finishes once")

// ── calendar identity: EventKit identity, never display title ──
let duplicateA = CalendarBackupIdentity(
    accountId: "account-a", calendarIdentifier: "calendar-A")
let duplicateB = CalendarBackupIdentity(
    accountId: "account-a", calendarIdentifier: "calendar-B")
check(duplicateA.itemKey != duplicateB.itemKey, "duplicate calendar titles have independent ledger keys")
check(duplicateA.fileName != duplicateB.fileName, "duplicate calendar titles have independent backup files")
check(duplicateA == CalendarBackupIdentity(
    accountId: "account-a", calendarIdentifier: "calendar-A"),
    "calendar identity is stable")
let otherAccountSameCalendar = CalendarBackupIdentity(
    accountId: "account-b", calendarIdentifier: "calendar-A")
check(duplicateA.itemKey != otherAccountSameCalendar.itemKey,
    "calendar ledger identity remains account-scoped")
check(duplicateA.fileName == otherAccountSameCalendar.fileName,
      "calendar filename depends only on the stable EventKit identifier")
check(duplicateA.fileName.hasPrefix("Calendar--") && duplicateA.fileName.hasSuffix(".ics"),
      "calendar filename has a fixed safe shape")
check(duplicateA.fileName.utf8.count == 78,
      "calendar filename is a bounded identifier digest")
check(CalendarBackupIdentity.requiresMigration(storedVersion: nil),
      "an install without an identity version needs one migration run")
check(CalendarBackupIdentity.requiresMigration(storedVersion: CalendarBackupIdentity.currentVersion - 1),
      "an older calendar identity version needs migration")
check(!CalendarBackupIdentity.requiresMigration(storedVersion: CalendarBackupIdentity.currentVersion),
      "the current calendar identity version does not rerun migration")
check(!CalendarBackupIdentity.requiresMigration(storedVersion: CalendarBackupIdentity.currentVersion + 1),
      "a newer calendar identity version is not downgraded")

check(CategoryBackupRunAdmission.started.rawValue == "started", "started admission has a stable bridge value")
check(CategoryBackupRunAdmission.alreadyRunning.rawValue == "already_running", "running admission has a stable bridge value")
check(CategoryBackupRunAdmission.notBound.rawValue == "not_bound", "unbound admission has a stable bridge value")
check(CategoryBackupRunAdmission.accountRefused.rawValue == "account_refused", "refused admission has a stable bridge value")

let identitySuite = "bb-calendar-identity-\(UUID().uuidString)"
let identityDefaults = UserDefaults(suiteName: identitySuite)!
defer { identityDefaults.removePersistentDomain(forName: identitySuite) }
let identityLedger = CategoryRunLedger(defaults: identityDefaults, prefix: "test.calendar.identity.")
identityLedger.setItemCount(100, for: duplicateA.itemKey)
check(identityLedger.itemCount(for: duplicateB.itemKey) == nil,
      "one duplicate-title calendar cannot become another calendar's baseline")
check(BackupExportVerification.gate(
    count: 1,
    localBaseline: identityLedger.itemCount(for: duplicateB.itemKey),
    force: false,
    serverBaseline: { .noBackup }) == .proceed(baselineToStore: nil),
    "a complete small duplicate-title calendar is not falsely refused")
identityLedger.setItemCount(1, for: duplicateB.itemKey)
check(identityLedger.itemCount(for: duplicateA.itemKey) == 100 && identityLedger.itemCount(for: duplicateB.itemKey) == 1,
      "duplicate-title calendar baselines stay independent")

print("backup-export-verification: \(assertions) assertions, 0 failed")
