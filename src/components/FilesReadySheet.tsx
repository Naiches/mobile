/**
 * "Beebeeb is ready in the Files app": shown after an unlock, and only when the Files app had asked
 * for it (the extension ended a request with "Authentication Required" a few minutes before; see
 * `../lib/files-ready.ts`). One line says they can go back to Files, where iOS shows its own
 * "Files" link at the top left, and a Done button closes it.
 *
 * Built on the shared `BottomSheet`, like `ConfirmActionPrompt`. The owner flips `visible` on and
 * `onDismissed` fires once the close animation has finished, so the owner can unmount it.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { radii } from '../theme';
import { BottomSheet, BottomSheetScrollView } from './sheet/BottomSheet';
import { useTheme } from '../lib/theme-context';

interface FilesReadySheetProps {
  visible: boolean;
  onDismissed: () => void;
}

export default function FilesReadySheet({ visible, onDismissed }: FilesReadySheetProps) {
  const { colors: c } = useTheme();
  const [mounted, setMounted] = useState(visible);
  const [open, setOpen] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setOpen(true);
    }
  }, [visible]);

  const close = useCallback(() => setOpen(false), []);
  const dismissed = useCallback(() => {
    setMounted(false);
    onDismissed();
  }, [onDismissed]);

  if (!mounted) return null;

  return (
    <Modal visible transparent statusBarTranslucent animationType="none" onRequestClose={close}>
      <GestureHandlerRootView style={styles.fill}>
        <BottomSheet
          visible={open}
          onRequestClose={close}
          onDismissed={dismissed}
          detents={['half']}
          initialDetent="half"
          contentStyle={styles.content}
          handleAccessibilityLabel="Beebeeb is ready in the Files app"
          scrimAccessibilityLabel="Done"
          testID="files-ready-sheet"
        >
          <BottomSheetScrollView contentContainerStyle={styles.body}>
            <Text style={[styles.title, { color: c.ink }]} accessibilityRole="header">
              Beebeeb is ready in the Files app
            </Text>
            <Text style={[styles.text, { color: c.ink3 }]}>
              You can go back to Files now. Tap the Files link at the top left of the screen.
            </Text>
            <TouchableOpacity
              style={[styles.primary, { backgroundColor: c.amber }]}
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Done"
              testID="files-ready-done"
            >
              <Text style={[styles.primaryText, { color: c.black }]}>Done</Text>
            </TouchableOpacity>
          </BottomSheetScrollView>
        </BottomSheet>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 24 },
  body: { paddingBottom: 16 },
  title: { fontSize: 20, fontWeight: '600', letterSpacing: -0.3, marginBottom: 6 },
  text: { fontSize: 14, lineHeight: 20, marginBottom: 20 },
  primary: { paddingVertical: 14, borderRadius: radii.md, alignItems: 'center' },
  primaryText: { fontSize: 16, fontWeight: '700' },
});
