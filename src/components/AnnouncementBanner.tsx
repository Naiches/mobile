/**
 * AnnouncementBanner — shows a server-sent announcement at the top of the
 * screen. Reads from AnnouncementContext (populated by the API response
 * interceptor in api.ts). Animates in/out with a simple height transition
 * using the built-in Animated API.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme-context';
import { useAnnouncement } from '../lib/announcement-context';

export default function AnnouncementBanner() {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { announcement, dismiss } = useAnnouncement();
  const { fontScale } = useWindowDimensions();
  const accessibilityLayout = fontScale >= 1.3;

  const anim = useRef(new Animated.Value(0)).current;
  const isVisible = announcement !== null;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: isVisible ? 1 : 0,
      duration: 250,
      useNativeDriver: false,
    }).start();
  }, [isVisible, anim]);

  // Don't render anything when fully hidden — saves a layout pass.
  // We keep rendering during the exit animation (anim > 0).
  const animatedOpacity = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

  const animatedTranslateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [-20, 0],
  });

  if (!isVisible) return null;

  return (
    <Animated.View
      style={[
        styles.banner,
        accessibilityLayout && styles.bannerAccessibility,
        {
          top: insets.top + 8,
          backgroundColor: c.amberBg,
          borderColor: c.line,
          opacity: animatedOpacity,
          transform: [{ translateY: animatedTranslateY }],
        },
      ]}
      pointerEvents="box-none"
    >
      <View
        style={[
          styles.iconCircle,
          accessibilityLayout && styles.iconCircleAccessibility,
          { backgroundColor: c.line2 },
        ]}
      >
        <Ionicons name="megaphone-outline" size={14} color={c.amberDeep} />
      </View>
      <Text
        style={[styles.text, { color: c.ink }]}
        numberOfLines={accessibilityLayout ? undefined : 2}
      >
        {announcement}
      </Text>
      <Pressable
        onPress={dismiss}
        hitSlop={12}
        style={[styles.dismiss, accessibilityLayout && styles.dismissAccessibility]}
        accessibilityRole="button"
        accessibilityLabel="Dismiss announcement"
      >
        <Ionicons name="close" size={16} color={c.ink3} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 998,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 10,
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 4,
  },
  bannerAccessibility: {
    alignItems: 'flex-start',
  },
  iconCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCircleAccessibility: {
    marginTop: 2,
  },
  text: {
    flex: 1,
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 16,
  },
  dismiss: {
    padding: 4,
  },
  dismissAccessibility: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
