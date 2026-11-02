import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COACH_MARK_COPY, coachMarkTargetForStep, type CoachMarkStep } from '../../lib/coach-marks';
import {
  coachMarkDimCells,
  coachMarkLayoutSignature,
  coachMarkPrimaryRect,
  coachMarkTabRect,
  paddedCoachMarkRect,
  type CoachMarkRect,
} from '../../lib/coach-mark-layout';
import { useCoachMarks } from '../../lib/coach-marks-context';
import { useTheme } from '../../lib/theme-context';
import { radii } from '../../theme';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function CoachMarks({
  enabled,
  navigateTo,
}: {
  enabled: boolean;
  navigateTo: (step: CoachMarkStep) => void;
}) {
  const insets = useSafeAreaInsets();
  const { width, height, fontScale } = useWindowDimensions();
  const { colors: c } = useTheme();
  const coach = useCoachMarks();
  const step = coach.state.status === 'active' ? coach.state.step : null;
  const [measuredTarget, setMeasuredTarget] = useState<{
    step: CoachMarkStep;
    layoutSignature: string;
    rect: CoachMarkRect;
  } | null>(null);
  const [readyLayout, setReadyLayout] = useState<string | null>(null);
  const [bubbleHeight, setBubbleHeight] = useState(150);
  const [bubbleMeasuredLayout, setBubbleMeasuredLayout] = useState<string | null>(null);
  const actionInFlightRef = useRef(false);
  const tabLayout = Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26
    ? 'detached-search'
    : 'equal-five';
  const layoutSignature = coachMarkLayoutSignature({ width, height, fontScale }, insets);
  const bubbleLayoutKey = `${step ?? 'none'}:${layoutSignature}`;

  useEffect(() => {
    let live = true;
    setMeasuredTarget(null);
    setReadyLayout(null);
    setBubbleHeight(150);
    setBubbleMeasuredLayout(null);
    if (!enabled || !step) return () => { live = false; };

    navigateTo(step);
    const target = coachMarkTargetForStep(step);
    if (!target) {
      setReadyLayout(bubbleLayoutKey);
      return () => { live = false; };
    }

    void (async () => {
      // A newly selected native tab needs a few frames before its RN target can
      // be measured. Bound the whole wait; the tab anchor remains a useful
      // fallback if the secondary control is unavailable.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (!live) return;
        const rect = await coach.measureTarget(target);
        if (rect) {
          if (live) setMeasuredTarget({ step, layoutSignature, rect });
          break;
        }
        await delay(120);
      }
      if (live) setReadyLayout(bubbleLayoutKey);
    })();
    return () => { live = false; };
  }, [bubbleLayoutKey, coach.measureTarget, enabled, navigateTo, step, layoutSignature]);

  useLayoutEffect(() => {
    setBubbleHeight(150);
    setBubbleMeasuredLayout(null);
  }, [bubbleLayoutKey]);

  const geometry = useMemo(() => {
    if (!step) return null;
    const tab = paddedCoachMarkRect(coachMarkTabRect(step, width, height, insets.bottom, tabLayout));
    const measured = measuredTarget?.step === step && measuredTarget.layoutSignature === layoutSignature
      ? paddedCoachMarkRect(measuredTarget.rect, 8)
      : null;
    const primary = coachMarkPrimaryRect(tab, measured);
    const holes = [primary];
    const bubbleWidth = Math.min(width - 32, 360);
    const centerX = primary.x + primary.width / 2;
    const left = Math.max(16, Math.min(width - bubbleWidth - 16, centerX - bubbleWidth / 2));
    const availableAbove = Math.max(0, primary.y - insets.top - 28);
    const availableBelow = Math.max(0, height - insets.bottom - primary.y - primary.height - 28);
    const bubbleBelow = availableBelow > availableAbove;
    const maxBubbleHeight = Math.max(44, bubbleBelow ? availableBelow : availableAbove);
    const renderedBubbleHeight = Math.min(bubbleHeight, maxBubbleHeight);
    const desiredTop = bubbleBelow
      ? primary.y + primary.height + 16
      : primary.y - renderedBubbleHeight - 16;
    const top = Math.max(insets.top + 12, Math.min(height - insets.bottom - renderedBubbleHeight - 12, desiredTop));
    const arrowX = Math.max(12, Math.min(width - 28, centerX - 8));
    return {
      holes,
      dimCells: coachMarkDimCells(width, height, holes),
      bubble: { left, top, width: bubbleWidth, maxHeight: maxBubbleHeight },
      bubbleBelow,
      arrow: { left: arrowX, top: bubbleBelow ? top - 12 : top + renderedBubbleHeight - 1 },
    };
  }, [bubbleHeight, height, insets.bottom, insets.top, layoutSignature, measuredTarget, step, tabLayout, width]);

  const visible = enabled && coach.ready && step != null && readyLayout === bubbleLayoutKey && geometry != null;
  if (!step || !geometry) return null;
  const copy = COACH_MARK_COPY[step];
  const runCoachAction = (action: () => Promise<void>) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    void action().finally(() => { actionInFlightRef.current = false; });
  };

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={() => runCoachAction(coach.skip)}
    >
      <View
        key={bubbleLayoutKey}
        style={[StyleSheet.absoluteFill, { opacity: bubbleMeasuredLayout === bubbleLayoutKey ? 1 : 0 }]}
        accessibilityViewIsModal
        testID={`coach-mark-${step}`}
      >
        {geometry.dimCells.map((cell, index) => (
          <View
            key={`${cell.x}-${cell.y}-${index}`}
            style={[styles.dim, { left: cell.x, top: cell.y, width: cell.width, height: cell.height }]}
          />
        ))}
        {geometry.holes.map((hole, index) => (
          <View
            key={`outline-${index}`}
            pointerEvents="none"
            style={[styles.outline, { borderColor: c.amber, left: hole.x, top: hole.y, width: hole.width, height: hole.height }]}
          />
        ))}
        <View
          pointerEvents="none"
          style={[
            styles.arrow,
            geometry.bubbleBelow
              ? { borderBottomColor: c.ink, borderBottomWidth: 12, borderTopWidth: 0 }
              : { borderTopColor: c.ink, borderTopWidth: 12, borderBottomWidth: 0 },
            geometry.arrow,
          ]}
        />
        <View
          style={[
            styles.bubble,
            {
              backgroundColor: c.ink,
              left: geometry.bubble.left,
              top: geometry.bubble.top,
              width: geometry.bubble.width,
              maxHeight: geometry.bubble.maxHeight,
            },
          ]}
          onLayout={(event) => {
            const next = event.nativeEvent.layout.height;
            if (Math.abs(next - bubbleHeight) > 1) setBubbleHeight(next);
            setBubbleMeasuredLayout(bubbleLayoutKey);
          }}
        >
          <ScrollView
            style={[
              styles.copyScroll,
              { maxHeight: Math.max(36, geometry.bubble.maxHeight - (fontScale >= 1.3 ? 150 : 92)) },
            ]}
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            <Text style={[styles.title, { color: c.paper }]}>{copy.title}</Text>
            <Text style={[styles.body, { color: c.paper }]}>{copy.body}</Text>
          </ScrollView>
          <View style={[styles.actions, fontScale >= 1.3 && styles.actionsLargeText]}>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => runCoachAction(coach.skip)}
              style={styles.action}
              testID="coach-mark-skip"
            >
              <Text style={[styles.skip, { color: c.paper }]}>Skip tips</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => runCoachAction(coach.next)}
              style={[styles.action, styles.next, { backgroundColor: c.amber }]}
              testID="coach-mark-next"
            >
              <Text style={[styles.nextText, { color: c.ink }]}>Next</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { position: 'absolute', backgroundColor: 'rgba(0, 0, 0, 0.62)' },
  outline: { position: 'absolute', borderWidth: 2, borderRadius: 16 },
  arrow: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  bubble: { position: 'absolute', borderRadius: radii.lg, padding: 16 },
  copyScroll: { flexShrink: 1 },
  title: { fontSize: 17, lineHeight: 22, fontWeight: '800' },
  body: { fontSize: 14, lineHeight: 20, marginTop: 5 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  actionsLargeText: { flexDirection: 'column-reverse', alignItems: 'stretch' },
  action: { minHeight: 44, minWidth: 84, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  skip: { fontSize: 14, fontWeight: '600' },
  next: { borderRadius: radii.md },
  nextText: { fontSize: 14, fontWeight: '800' },
});
