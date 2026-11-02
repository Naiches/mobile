import React from 'react';
import { StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFirstRunSetup } from '../../lib/first-run-context';
import { FIRST_RUN_ITEM_LABELS } from '../../lib/first-run-setup';
import { useTheme } from '../../lib/theme-context';
import { radii, spacing } from '../../theme';

export function FinishSetupCard({ onContinue }: { onContinue: () => void }) {
  const setup = useFirstRunSetup();
  const { colors: c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const accessibilityLayout = fontScale >= 1.3;
  if (!setup.shouldShowFinishCard) return null;

  const labels = setup.state.remaining.map((item) => FIRST_RUN_ITEM_LABELS[item]);
  return (
    <View style={[styles.card, { backgroundColor: c.amberBg, borderColor: c.amber }]} testID="finish-setup-card">
      <View style={[styles.titleRow, accessibilityLayout && styles.titleRowAccessibility]}>
        <View style={styles.heading}>
          <Ionicons name="sparkles-outline" size={19} color={c.amberDeep} />
          <Text style={[styles.title, { color: c.ink }]}>Finish setup</Text>
        </View>
        <TouchableOpacity
          onPress={() => { void setup.dismissCard(); }}
          accessibilityRole="button"
          accessibilityLabel="Dismiss finish setup"
          testID="finish-setup-dismiss"
          style={accessibilityLayout ? styles.actionButton : undefined}
        >
          <Text style={[styles.action, { color: c.amberDeep }]}>Dismiss</Text>
        </TouchableOpacity>
      </View>
      <Text style={[styles.body, { color: c.ink2 }]}>Still to do: {labels.join(', ')}.</Text>
      <TouchableOpacity onPress={onContinue} accessibilityRole="button" testID="finish-setup-continue" style={accessibilityLayout ? styles.actionButton : undefined}>
        <Text style={[styles.action, { color: c.amberDeep }]}>Continue setup</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radii.lg, padding: spacing.md, marginBottom: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  titleRowAccessibility: { alignItems: 'flex-start', flexWrap: 'wrap' },
  heading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { fontSize: 15, fontWeight: '700' },
  body: { fontSize: 13, lineHeight: 19, marginVertical: spacing.sm },
  action: { fontSize: 13, fontWeight: '600' },
  actionButton: { minHeight: 44, justifyContent: 'center', paddingVertical: spacing.sm },
});
