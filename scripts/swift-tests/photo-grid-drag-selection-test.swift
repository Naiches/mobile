import Foundation

// Pure interaction policy used by the shipped native Photos grid.
// The REAL shipped source (ThumbnailServiceTypes.swift) is compiled with this driver.

var assertions = 0
var failures: [String] = []

func check(_ condition: @autoclosure () -> Bool, _ name: String) {
  assertions += 1
  if condition() {
    print("PASS: \(name)")
  } else {
    failures.append(name)
    print("FAIL: \(name)")
  }
}

func approximatelyEqual(_ lhs: CGFloat, _ rhs: CGFloat, tolerance: CGFloat = 0.001) -> Bool {
  abs(lhs - rhs) <= tolerance
}

let visibleTop: CGFloat = 100
let visibleBottom: CGFloat = 700

check(
  approximatelyEqual(
    PhotoGridDragSelectionPolicy.autoscrollVelocity(
      pointerY: visibleTop + PhotoGridDragSelectionPolicy.edgeThreshold,
      visibleMinY: visibleTop,
      visibleMaxY: visibleBottom
    ),
    0
  ),
  "top edge zone starts at 80 points"
)
check(
  approximatelyEqual(
    PhotoGridDragSelectionPolicy.autoscrollVelocity(
      pointerY: visibleBottom - PhotoGridDragSelectionPolicy.edgeThreshold,
      visibleMinY: visibleTop,
      visibleMaxY: visibleBottom
    ),
    0
  ),
  "bottom edge zone starts at 80 points"
)

let topFar = PhotoGridDragSelectionPolicy.autoscrollVelocity(
  pointerY: visibleTop + 60,
  visibleMinY: visibleTop,
  visibleMaxY: visibleBottom
)
let topNear = PhotoGridDragSelectionPolicy.autoscrollVelocity(
  pointerY: visibleTop + 10,
  visibleMinY: visibleTop,
  visibleMaxY: visibleBottom
)
check(topFar < 0, "top edge scrolls upward")
check(abs(topNear) > abs(topFar), "top speed rises closer to the edge")

let bottomFar = PhotoGridDragSelectionPolicy.autoscrollVelocity(
  pointerY: visibleBottom - 60,
  visibleMinY: visibleTop,
  visibleMaxY: visibleBottom
)
let bottomNear = PhotoGridDragSelectionPolicy.autoscrollVelocity(
  pointerY: visibleBottom - 10,
  visibleMinY: visibleTop,
  visibleMaxY: visibleBottom
)
check(bottomFar > 0, "bottom edge scrolls downward")
check(abs(bottomNear) > abs(bottomFar), "bottom speed rises closer to the edge")
check(
  approximatelyEqual(
    PhotoGridDragSelectionPolicy.autoscrollVelocity(
      pointerY: visibleTop - 200,
      visibleMinY: visibleTop,
      visibleMaxY: visibleBottom
    ),
    -PhotoGridDragSelectionPolicy.maximumAutoscrollSpeed
  ),
  "top speed is capped"
)
check(
  approximatelyEqual(
    PhotoGridDragSelectionPolicy.autoscrollVelocity(
      pointerY: visibleBottom + 200,
      visibleMinY: visibleTop,
      visibleMaxY: visibleBottom
    ),
    PhotoGridDragSelectionPolicy.maximumAutoscrollSpeed
  ),
  "bottom speed is capped"
)
check(
  approximatelyEqual(
    PhotoGridDragSelectionPolicy.autoscrollVelocity(
      pointerY: 400,
      visibleMinY: visibleTop,
      visibleMaxY: visibleBottom
    ),
    0
  ),
  "moving away from both edges stops autoscroll"
)

check(
  PhotoGridDragSelectionPolicy.selectedRange(from: 2, to: 6, itemCount: 10) == 2...6,
  "selection range extends forward"
)
check(
  PhotoGridDragSelectionPolicy.selectedRange(from: 6, to: 2, itemCount: 10) == 2...6,
  "selection range extends backward"
)
check(
  PhotoGridDragSelectionPolicy.selectedRange(from: 4, to: 4, itemCount: 10) == 4...4,
  "selection range includes a stationary cell"
)
check(
  PhotoGridDragSelectionPolicy.selectedRange(from: -1, to: 4, itemCount: 10) == nil,
  "selection range rejects a negative index"
)
check(
  PhotoGridDragSelectionPolicy.selectedRange(from: 4, to: 10, itemCount: 10) == nil,
  "selection range rejects an index past the last item"
)

check(
  PhotoGridDragSelectionPolicy.isUserScrollingEnabled(isDragSelecting: false),
  "ordinary grid scrolling stays enabled"
)
check(
  !PhotoGridDragSelectionPolicy.isUserScrollingEnabled(isDragSelecting: true),
  "user scrolling is disabled during drag selection"
)

check(
  PhotoGridDragSelectionPolicy.anchor(
    forNewDragAt: 8,
    pendingLongPressAnchor: 2,
    longPressIsActive: false
  ) == 8,
  "a later drag starts at its own cell instead of a stale long-press anchor"
)
check(
  PhotoGridDragSelectionPolicy.anchor(
    forNewDragAt: 8,
    pendingLongPressAnchor: 2,
    longPressIsActive: true
  ) == 2,
  "a drag continuing the active long press keeps the original anchor"
)
check(
  PhotoGridDragSelectionPolicy.anchor(
    forNewDragAt: 8,
    pendingLongPressAnchor: Optional<Int>.none,
    longPressIsActive: true
  ) == 8,
  "an active long press without an anchor falls back to the touched cell"
)

if failures.isEmpty {
  print("photo-grid-drag-selection: \(assertions) assertions, 0 failed")
  exit(0)
}

print("photo-grid-drag-selection: \(failures.count) of \(assertions) assertions FAILED")
exit(1)
