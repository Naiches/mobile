import Foundation
import CoreGraphics

public typealias FileId = String

public enum ThumbnailSource: String, Sendable, Equatable {
  case photoKit
  case remote
  case cache
}

public struct ResolvedThumbnail: Sendable, Equatable {
  public let fileURL: URL
  public let source: ThumbnailSource
}

public enum ThumbnailQuality: Sendable, Equatable {
  case continuous(width: Int, jpegQuality: Float)

  static let renderDefault: ThumbnailQuality = .continuous(width: 768, jpegQuality: 0.35)
}

public enum FsmState: Sendable, Equatable {
  case unresolved
  case photoKitPending
  case photoKitResolved(URL)
  case staleLocalId
  case remotePending
  case remoteResolved(URL)
  case remoteFailed(category: FailureCategory)
}

public enum FailureCategory: String, Sendable, Equatable {
  case network5xx
  case network429
  case photoKitMissing
  case decryptFailed
  case generateFailed
  case uploadTooLarge
  case timeout
  case notImplemented
  case unknown
}

public struct CacheKey: Hashable, Sendable {
  public let fileId: FileId
  public let source: ThumbnailSource
  /// Remote thumbnail variant ("medium" or "small"); PhotoKit entries use the default.
  public var variant: String = "medium"
}

public enum ThumbnailServiceError: Error, Sendable, Equatable {
  case cancelled
  case notImplemented
  case photoKitMissing(localId: String)
  case remoteUnavailable
  case decryptFailed
  case ioFailure(String)
}

/// Which remote thumbnail variant the Photos grid asks for, and when to stop asking
/// for `small`. Pure logic (no I/O) so it is unit-tested by `scripts/swift-tests`.
enum ThumbnailVariantPolicy {
  /// Dense steps (7 and 12 columns) use the small 384 px thumbnail; 2 and 4 use medium.
  static func variant(forColumns columns: Int) -> String {
    columns >= 7 ? "small" : "medium"
  }

  /// A cell showing a small image must be upgraded once the grid is at medium density.
  static func needsUpgrade(showingSmall: Bool, wanted: String) -> Bool {
    showingSmall && wanted == "medium"
  }
}

/// Pure interaction rules shared by the native Photos grid and its Swift harness.
enum PhotoGridDragSelectionPolicy {
  static let edgeThreshold: CGFloat = 80
  static let maximumAutoscrollSpeed: CGFloat = 420

  /// Points per second. Negative scrolls toward older content above the viewport.
  static func autoscrollVelocity(
    pointerY: CGFloat,
    visibleMinY: CGFloat,
    visibleMaxY: CGFloat
  ) -> CGFloat {
    guard visibleMaxY > visibleMinY else { return 0 }

    if pointerY < visibleMinY + edgeThreshold {
      return -speed(distanceFromEdge: pointerY - visibleMinY)
    }
    if pointerY > visibleMaxY - edgeThreshold {
      return speed(distanceFromEdge: visibleMaxY - pointerY)
    }
    return 0
  }

  static func selectedRange(from start: Int, to end: Int, itemCount: Int) -> ClosedRange<Int>? {
    guard itemCount > 0,
          start >= 0, start < itemCount,
          end >= 0, end < itemCount else {
      return nil
    }
    return min(start, end)...max(start, end)
  }

  static func isUserScrollingEnabled(isDragSelecting: Bool) -> Bool {
    !isDragSelecting
  }

  /// A long press may seed the first range only while that same press is still
  /// active. Once the finger has lifted, a later drag starts at its own cell.
  static func anchor<Index>(
    forNewDragAt touchedIndex: Index,
    pendingLongPressAnchor: Index?,
    longPressIsActive: Bool
  ) -> Index {
    guard longPressIsActive, let pendingLongPressAnchor else {
      return touchedIndex
    }
    return pendingLongPressAnchor
  }

  private static func speed(distanceFromEdge: CGFloat) -> CGFloat {
    let normalizedDistance = min(1, max(0, distanceFromEdge / edgeThreshold))
    let pressure = 1 - normalizedDistance
    return maximumAutoscrollSpeed * pressure * pressure
  }
}

/// Result of one `small` download attempt.
enum SmallFetchOutcome: Equatable {
  /// The small thumbnail was downloaded.
  case hit
  /// The server has no small thumbnail for this file (404).
  case missing
  /// Rate limit, server error or network fault: says nothing about whether small exists.
  case transient
}

/// Session-long memory of missing small thumbnails. Backup uploads create small, but
/// older photos have none, so a miss falls back to medium. A miss is remembered per file;
/// `missLimit` misses in a row mean the server holds no small thumbnails for this
/// account, and small requests stop for the session (no 404 storm on a big grid).
/// Transient failures fall back to medium but never count as a miss.
struct SmallVariantTracker {
  static let missLimit = 3

  private(set) var missingFiles: Set<String> = []
  private(set) var consecutiveMisses = 0

  func shouldTry(_ fileId: String) -> Bool {
    consecutiveMisses < Self.missLimit && !missingFiles.contains(fileId)
  }

  mutating func record(_ outcome: SmallFetchOutcome, fileId: String) {
    switch outcome {
    case .hit:
      consecutiveMisses = 0
    case .missing:
      missingFiles.insert(fileId)
      consecutiveMisses += 1
    case .transient:
      break
    }
  }

  mutating func forget(_ fileId: String) {
    missingFiles.remove(fileId)
  }
}
