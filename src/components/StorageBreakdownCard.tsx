/**
 * Storage page: what uses the space. Plain lists with a segmented bar, worked
 * out on this phone (src/lib/storage-breakdown.ts).
 */
import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { formatBytes } from '../lib/format';
import type { StorageBreakdown, Tally } from '../lib/storage-breakdown';
import type { Colors } from '../theme';

interface Segment { key: string; label: string; tally: Tally; color: string }

function fileCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'file' : 'files'}`;
}

function SegmentBar({ segments, total, c, testID }: { segments: Segment[]; total: number; c: Colors; testID: string }) {
  return (
    <View style={[styles.bar, { backgroundColor: c.line }]} testID={testID}>
      {total > 0
        ? segments.filter((s) => s.tally.bytes > 0).map((s) => (
            <View key={s.key} style={{ flex: s.tally.bytes, backgroundColor: s.color }} />
          ))
        : null}
    </View>
  );
}

function Row({ s, c, testID, indent, accessibilityLayout }: {
  s: Segment;
  c: Colors;
  testID: string;
  indent?: boolean;
  accessibilityLayout: boolean;
}) {
  return (
    <View
      style={[
        styles.row,
        accessibilityLayout && styles.rowAccessibility,
        indent ? styles.indent : null,
      ]}
      testID={testID}
    >
      <View style={[styles.swatch, { backgroundColor: s.color }]} />
      <Text
        style={[styles.label, { color: c.ink }]}
        numberOfLines={accessibilityLayout ? undefined : 1}
      >
        {s.label}
      </Text>
      <Text
        style={[styles.value, accessibilityLayout && styles.valueAccessibility, { color: c.ink3 }]}
      >
        {`${formatBytes(s.tally.bytes)} · ${fileCount(s.tally.count)}`}
      </Text>
    </View>
  );
}

export function StorageBreakdownCard({ breakdown, totalBytes, c }: {
  breakdown: StorageBreakdown;
  totalBytes: number | null;
  c: Colors;
}) {
  const { fontScale } = useWindowDimensions();
  const accessibilityLayout = fontScale >= 1.3;
  const remainder: Tally = { bytes: breakdown.otherStorageBytes, count: 0 };
  const hasRemainder = remainder.bytes > 0;
  const barTotal = (totalBytes ?? 0) > 0 ? (totalBytes as number) : 0;
  const other: Segment = { key: 'rest', label: 'Other storage', tally: remainder, color: c.line2 };

  const types: Segment[] = [
    { key: 'media', label: 'Photos & videos', tally: breakdown.byType.photosVideos, color: c.amber },
    { key: 'docs', label: 'Documents', tally: breakdown.byType.documents, color: c.amberDeep },
    { key: 'other', label: 'Other', tally: breakdown.byType.other, color: c.ink3 },
  ];
  const b = breakdown.backups;
  const backupsSeg: Segment = { key: 'backups', label: 'Backups', tally: b.total, color: c.amber };
  const yoursSeg: Segment = { key: 'yours', label: 'Your files', tally: breakdown.yourFiles, color: c.ink3 };
  const backupParts: Segment[] = [
    { key: 'cam', label: 'Camera roll', tally: b.cameraRoll, color: c.amber },
    { key: 'cc', label: 'Contacts & Calendar', tally: b.contactsCalendar, color: c.amber },
    { key: 'wa', label: 'WhatsApp', tally: b.whatsapp, color: c.amber },
    { key: 'ob', label: 'Other backups', tally: b.other, color: c.amber },
  ].filter((s) => s.tally.count > 0);

  const sum = (segs: Segment[]) => segs.reduce((n, s) => n + s.tally.bytes, 0) + remainder.bytes;

  return (
    <View testID="storage-breakdown">
      <Text style={[styles.header, { color: c.ink3 }]}>By type</Text>
      <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]} testID="storage-breakdown-types">
        <SegmentBar segments={hasRemainder ? [...types, other] : types} total={barTotal || sum(types)} c={c} testID="storage-breakdown-types-bar" />
        {types.map((s) => <Row key={s.key} s={s} c={c} testID={`storage-type-${s.key}`} accessibilityLayout={accessibilityLayout} />)}
        {hasRemainder ? <Row s={other} c={c} testID="storage-type-rest" accessibilityLayout={accessibilityLayout} /> : null}
      </View>

      <Text style={[styles.header, { color: c.ink3, marginTop: 16 }]}>Backups and your files</Text>
      <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]} testID="storage-breakdown-split">
        <SegmentBar segments={hasRemainder ? [backupsSeg, yoursSeg, other] : [backupsSeg, yoursSeg]} total={barTotal || sum([backupsSeg, yoursSeg])} c={c} testID="storage-breakdown-split-bar" />
        <Row s={backupsSeg} c={c} testID="storage-split-backups" accessibilityLayout={accessibilityLayout} />
        {backupParts.map((s) => <Row key={s.key} s={s} c={c} testID={`storage-backup-${s.key}`} indent accessibilityLayout={accessibilityLayout} />)}
        <Row s={yoursSeg} c={c} testID="storage-split-yours" accessibilityLayout={accessibilityLayout} />
        {hasRemainder ? <Row s={other} c={c} testID="storage-split-rest" accessibilityLayout={accessibilityLayout} /> : null}
      </View>
      {hasRemainder ? (
        <Text style={[styles.note, { color: c.ink3 }]} testID="storage-breakdown-note">
          Other storage covers items that are not in your file list, such as the trash and older versions.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 6, marginBottom: 6 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  bar: { height: 6, borderRadius: 3, overflow: 'hidden', flexDirection: 'row' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowAccessibility: { alignItems: 'flex-start', flexWrap: 'wrap' },
  indent: { paddingLeft: 16 },
  swatch: { width: 8, height: 8, borderRadius: 4 },
  label: { flex: 1, fontSize: 14 },
  value: { fontSize: 12 },
  valueAccessibility: { flexBasis: '100%', marginLeft: 16 },
  note: { fontSize: 11, paddingHorizontal: 6, marginTop: 6, lineHeight: 16 },
});
