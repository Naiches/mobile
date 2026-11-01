import Foundation

/// Reads what the account already holds for a Contacts or Calendar backup, so
/// the "incomplete export" rule has a baseline on a device that has none (new
/// phone, reinstall, sign-in again, first run after an update).
///
/// One folder listing is shared by every lookup of a run. The backup file is
/// downloaded and decrypted by the same native streaming path the preview uses,
/// into a protected temp file that is read once and removed. Backups of this
/// kind are small; anything over `maxBytes` is reported as unavailable (the run
/// is refused, and "Back up anyway" remains).
private final class ResultBox<T>: @unchecked Sendable { var value: T? }

final class CategoryBackupBaselineFetcher {
  static let maxBytes = 64 * 1024 * 1024
  private static let maxPages = 40

  private let apiUrl: String
  private let token: String
  private let parentFolderId: String
  private var listing: [BackupExportVerification.ListingEntry]?
  private var names: [String?] = []

  init(apiUrl: String, token: String, parentFolderId: String) {
    self.apiUrl = apiUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    self.token = token
    self.parentFolderId = parentFolderId
  }

  /// `count` parses the downloaded bytes into an entry count (nil when the
  /// file is malformed).
  func baseline(fileName: String, count: (Data) -> Int?) -> BackupExportVerification.ServerBaseline {
    guard let master = BeebeebCryptoBridge.cachedMasterKeyIfAvailable() else { return .unavailable }
    guard loadListing(master: master) else { return .unavailable }
    guard let entries = listing,
          let entry = BackupExportVerification.newestEntry(named: fileName, entries: entries, names: names)
    else { return .noBackup }
    guard entry.sizeBytes <= Self.maxBytes else { return .unavailable }

    let out = FileManager.default.temporaryDirectory
      .appendingPathComponent("backup-baseline-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: out) }
    FileManager.default.createFile(atPath: out.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete])

    let ok = ResultBox<Bool>()
    let done = DispatchSemaphore(value: 0)
    let apiUrl = self.apiUrl, token = self.token
    Task {
      do {
        _ = try await downloadDecryptedFileToDisk(
          master: master, apiUrl: apiUrl, token: token,
          fileId: entry.id, nameEncrypted: entry.nameEncrypted, outputURL: out)
        ok.value = true
      } catch {
        RuntimeTrace.event("backup.baseline.download_failed", ["error": error.localizedDescription])
      }
      done.signal()
    }
    done.wait()
    guard ok.value == true else { return .unavailable }
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: out.path),
          let size = (attrs[.size] as? NSNumber)?.intValue, size <= Self.maxBytes,
          let data = try? Data(contentsOf: out, options: .mappedIfSafe),
          let found = count(data) else { return .unavailable }
    return .count(found)
  }

  private func loadListing(master: MasterKeyHandle) -> Bool {
    if listing != nil { return true }
    var all: [BackupExportVerification.ListingEntry] = []
    var cursor: String?
    for _ in 0..<Self.maxPages {
      var comps = URLComponents(string: "\(apiUrl)/api/v1/files")
      var items = [URLQueryItem(name: "parent_id", value: parentFolderId), URLQueryItem(name: "limit", value: "200")]
      if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
      comps?.queryItems = items
      guard let url = comps?.url else { return false }
      var request = URLRequest(url: url)
      ProvenanceHeaders.apply(to: &request)
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      request.timeoutInterval = 30
      guard let data = Self.fetch(request),
            let page = BackupExportVerification.parseListing(data) else { return false }
      all += page.entries
      guard let next = page.nextCursor else {
        listing = all
        let batch = all.map { BatchNameItem(fileId: $0.id, nameEncrypted: $0.nameEncrypted) }
        let results = (try? SharedKeyOps.decryptNames(master: master, items: batch)) ?? []
        names = (0..<all.count).map { $0 < results.count ? results[$0].name : nil }
        return true
      }
      cursor = next
    }
    return false
  }

  private static func fetch(_ request: URLRequest) -> Data? {
    let result = ResultBox<Data>()
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, response, _ in
      if let http = response as? HTTPURLResponse, http.statusCode == 200 { result.value = data }
      done.signal()
    }.resume()
    done.wait()
    return result.value
  }
}
