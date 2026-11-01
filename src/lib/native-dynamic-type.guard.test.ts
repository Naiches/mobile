// @ts-nocheck -- bun:test types are intentionally outside the Expo tsconfig.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

const photosGrid = read('modules/beebeeb-crypto/ios/NativePhotosGridView.swift');
const shareSource = read('targets/share-extension/ShareViewController.swift');
const shareBuildCopy = read('ios/BeebeebShare/ShareViewController.swift');
const widget = read('ios/BeebeebWidget/BeebeebWidget.swift');

describe('native Dynamic Type guard', () => {
  test('the native Photos month header scales and gives its custom layout matching space', () => {
    expect(photosGrid).not.toMatch(/(?:label|count)\.font\s*=\s*UIFont\.systemFont/);
    expect(photosGrid.match(/adjustsFontForContentSizeCategory\s*=\s*true/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(photosGrid).toContain('preferredContentSizeCategory');
    expect(photosGrid).toContain('isAccessibilityCategory');
    expect(photosGrid).toMatch(/var headerHeight:\s*CGFloat\s*=\s*44/);
    expect(photosGrid).not.toMatch(/private let headerHeight:\s*CGFloat\s*=\s*44/);
  });

  test('the Share extension scales every visible label and self-sizes its text rows', () => {
    expect(shareBuildCopy).toBe(shareSource);
    expect(shareSource).not.toMatch(/\.font\s*=\s*UIFont\.systemFont/);
    expect(shareSource.match(/adjustsFontForContentSizeCategory\s*=\s*true/g)?.length ?? 0).toBeGreaterThanOrEqual(12);
    expect(shareSource).toContain('tableView.rowHeight = UITableView.automaticDimension');
    expect(shareSource).toContain('tableView.sectionHeaderHeight = UITableView.automaticDimension');
    expect(shareSource).toContain('tableView.bottomAnchor.constraint(equalTo: bottomBar.topAnchor)');
    expect(shareSource).toContain('greaterThanOrEqualToConstant: 72');
    expect(shareSource).toContain('greaterThanOrEqualToConstant: 60');
    expect(shareSource).not.toMatch(/return\s+(?:32|48)\b/);
  });

  test('widgets scale exact existing point sizes and cap only constrained percentages', () => {
    expect(widget).not.toMatch(/\.font\(\.system\(size:\s*\d/);
    expect(widget.match(/@ScaledMetric/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(widget).toContain('constrainedPercentageScaleCap');
    expect(widget).toContain('dynamicTypeSize.isAccessibilitySize');
    expect(widget).not.toContain('.lineLimit(1)');
  });
});
