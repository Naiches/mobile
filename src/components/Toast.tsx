import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';
import type { ToastMessage, ToastType } from '../lib/toast-context';

// ---------------------------------------------------------------------------
// Config per toast type
// ---------------------------------------------------------------------------

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const TYPE_CONFIG: Record<ToastType, { icon: IoniconName; getColor: (c: ReturnType<typeof useTheme>['colors']) => string }> = {
  success: { icon: 'checkmark-circle',   getColor: (c) => c.green },
  error:   { icon: 'close-circle',        getColor: (c) => c.red },
  info:    { icon: 'information-circle',  getColor: (c) => c.amber },
};

const DISMISS_AFTER_MS = 2500;
const DISMISS_AFTER_WITH_ACTION_MS = 6000;
const SLIDE_IN_MS = 220;
const SLIDE_OUT_MS = 180;

export function toastDurationMs(toast: Pick<ToastMessage, 'action' | 'secondaryAction'>): number {
  return toast.action || toast.secondaryAction ? DISMISS_AFTER_WITH_ACTION_MS : DISMISS_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  toast: ToastMessage;
  onDismiss: () => void;
}

export default function ToastOverlay({ toast, onDismiss }: Props) {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const hasActions = !!(toast.action || toast.secondaryAction);
  const stackActions = hasActions && fontScale > 1.3;
  const hiddenOffset = stackActions ? -240 : -80;
  const translateY = useRef(new Animated.Value(hiddenOffset)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  const cfg = TYPE_CONFIG[toast.type];
  const accentColor = cfg.getColor(c);

  useEffect(() => {
    // Slide in
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: SLIDE_IN_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: SLIDE_IN_MS,
        useNativeDriver: true,
      }),
    ]).start();

    // Auto-dismiss
    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: hiddenOffset,
          duration: SLIDE_OUT_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: SLIDE_OUT_MS,
          useNativeDriver: true,
        }),
      ]).start(() => onDismiss());
    }, toastDurationMs(toast));

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View
      style={[
        styles.container,
        stackActions && styles.containerStacked,
        {
          top: insets.top + 8,
          backgroundColor: c.paper,
          borderColor: c.line,
          transform: [{ translateY }],
          opacity,
          shadowColor: c.ink,
        },
      ]}
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${toast.type}: ${toast.message}`}
    >
      <View style={[styles.messageRow, !stackActions && styles.messageRowInline]}>
        <Ionicons name={cfg.icon} size={20} color={accentColor} />
        <Text style={[styles.message, { color: c.ink }]}>
          {toast.message}
        </Text>
      </View>
      {hasActions ? (
        <View style={[styles.actions, stackActions && styles.actionsStacked]}>
          {toast.action ? (
            <Pressable
              onPress={() => { toast.action?.onPress(); onDismiss(); }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={toast.action.label}
              style={stackActions ? styles.actionButtonStacked : undefined}
            >
              <Text style={[styles.action, { color: accentColor }]}>{toast.action.label}</Text>
            </Pressable>
          ) : null}
          {toast.secondaryAction ? (
            <Pressable
              onPress={() => { toast.secondaryAction?.onPress(); onDismiss(); }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={toast.secondaryAction.label}
              style={stackActions ? styles.actionButtonStacked : undefined}
            >
              <Text style={[styles.action, { color: c.ink2 }]}>{toast.secondaryAction.label}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 9999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 6,
  },
  containerStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 6,
  },
  messageRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  messageRowInline: {
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  actionsStacked: {
    alignSelf: 'stretch',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    paddingLeft: 30,
    rowGap: 4,
  },
  actionButtonStacked: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  action: {
    fontSize: 14,
    fontWeight: '700',
  },
  message: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 19,
  },
});
