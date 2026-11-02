import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radii, shadows, spacing } from '../theme';
import { useTheme } from '../lib/theme-context';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function DevicePairingScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const accessibilityLayout = fontScale >= 1.3;

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: c.paper2 }]}
      contentContainerStyle={[styles.content, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View style={[styles.header, accessibilityLayout && styles.headerAccessibility]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <View style={[styles.backArrow, { borderColor: c.ink2 }]} />
          <Text style={[styles.backText, { color: c.ink2 }]}>Back</Text>
        </TouchableOpacity>
        <Text
          style={[styles.heading, accessibilityLayout && styles.headingAccessibility, { color: c.ink }]}
          numberOfLines={accessibilityLayout ? 2 : 1}
        >
          Add a device
        </Text>
        {!accessibilityLayout && <View style={styles.headerSpacer} />}
      </View>

      <Text style={[styles.subheading, { color: c.ink3 }]}>
        Link another device to your account. Both devices must be unlocked.
      </Text>

      <View style={styles.cards}>
        {/* Card A: Scan */}
        <TouchableOpacity
          style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}
          onPress={() => navigation.navigate('DevicePairingScan')}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Scan with this device"
          accessibilityHint="Opens the camera to scan a pattern shown on another device"
        >
          <View style={[styles.cardIcon, { backgroundColor: c.amberBg }]}>
            {/* Camera outline */}
            <View style={[styles.cameraBody, { borderColor: c.amberDeep }]}>
              <View style={[styles.cameraLens, { borderColor: c.amberDeep }]} />
            </View>
          </View>
          <Text style={[styles.cardTitle, { color: c.ink }]}>Scan with this device</Text>
          <Text style={[styles.cardDesc, { color: c.ink3 }]}>
            Point your camera at the pattern shown on your other device.
          </Text>
          <View style={styles.cardArrow}>
            <Text style={[styles.cardArrowText, { color: c.ink4 }]}>→</Text>
          </View>
        </TouchableOpacity>

        {/* Card B: Show */}
        <TouchableOpacity
          style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}
          onPress={() => navigation.navigate('DevicePairingShow')}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Show on this device"
          accessibilityHint="Displays a pattern for another device to scan"
        >
          <View style={[styles.cardIcon, { backgroundColor: c.line }]}>
            {/* Globe outline (neutral ink — shape differentiates from the amber Scan card) */}
            <View style={[styles.globeOuter, { borderColor: c.ink2 }]}>
              <View style={[styles.globeH, { backgroundColor: c.ink2 }]} />
              <View style={[styles.globeV, { backgroundColor: c.ink2 }]} />
            </View>
          </View>
          <Text style={[styles.cardTitle, { color: c.ink }]}>Show on this device</Text>
          <Text style={[styles.cardDesc, { color: c.ink3 }]}>
            Display a pattern for your other device to scan.
          </Text>
          <View style={styles.cardArrow}>
            <Text style={[styles.cardArrowText, { color: c.ink4 }]}>→</Text>
          </View>
        </TouchableOpacity>
      </View>

      <Text style={[styles.footnote, { color: c.ink4 }]}>
        Your key material never leaves either device. Pairing uses an encrypted local channel.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flexGrow: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerAccessibility: { alignItems: 'flex-start', flexWrap: 'wrap' },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minWidth: 60,
  },
  backArrow: {
    width: 8,
    height: 8,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    transform: [{ rotate: '45deg' }],
  },
  backText: { fontSize: 14 },
  heading: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: -0.2,
  },
  headingAccessibility: { flex: undefined, flexBasis: '100%', width: '100%', textAlign: 'left', marginTop: spacing.sm },
  headerSpacer: { minWidth: 60 },

  subheading: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    paddingHorizontal: spacing.xl,
    marginBottom: spacing['2xl'],
  },

  cards: {
    paddingHorizontal: spacing.lg,
    gap: 14,
  },

  card: {
    borderRadius: radii.xl,
    borderWidth: 1,
    padding: spacing.xl,
    ...shadows.md,
  },

  cardIcon: {
    width: 52,
    height: 52,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },

  // Camera icon
  cameraBody: {
    width: 28,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraLens: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },

  // Globe icon
  globeOuter: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  globeH: {
    position: 'absolute',
    width: 26,
    height: 2,
    opacity: 0.6,
  },
  globeV: {
    position: 'absolute',
    width: 2,
    height: 26,
    opacity: 0.6,
  },

  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
    letterSpacing: -0.2,
  },
  cardDesc: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  cardArrow: { alignSelf: 'flex-end' },
  cardArrowText: { fontSize: 16 },

  footnote: {
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 16,
    paddingHorizontal: spacing.xl,
    marginTop: spacing['2xl'],
  },
});
