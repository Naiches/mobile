/**
 * Screen-side glue for "Duplicate", shared by the preview menu and the Drive
 * row menu: the large-file question, a progress sheet with Cancel, and the
 * result toast. The flow itself is duplicate-file.ts; its real effects are
 * duplicate-file-deps.ts.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { ApiError, friendlyError } from './api'
import type { FileEntry } from './api'
import { DuplicateCancelledError, DuplicateRefusedError, needsLargeFileConfirm, type DuplicateSource } from './duplicate-file'
import { runDuplicate } from './duplicate-file-deps'
import { useCrypto } from './crypto-context'
import { useTheme } from './theme-context'
import { useToast } from './toast-context'

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/** The large-file question. Resolves true when the person continues. */
export function confirmLargeDuplicate(sizeBytes: number): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Duplicate this file?',
      `This file is ${formatBytes(sizeBytes)}. Duplicating downloads and uploads it again. Continue?`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    )
  })
}

interface ProgressSheetHandle {
  setPercent: (percent: number) => void
}

const DuplicateProgressSheet = forwardRef<ProgressSheetHandle, { name: string; onCancel: () => void }>(
  function DuplicateProgressSheet({ name, onCancel }, ref) {
    const { colors: c } = useTheme()
    const [percent, setPercent] = useState(0)
    useImperativeHandle(ref, () => ({ setPercent }), [])
    return (
      <Modal transparent animationType="fade" onRequestClose={onCancel}>
        <View style={styles.backdrop}>
          <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <Text style={[styles.title, { color: c.ink }]}>Duplicating… {percent}%</Text>
            <Text style={[styles.name, { color: c.ink3 }]}>{name}</Text>
            <View style={[styles.track, { backgroundColor: c.line }]}>
              <View style={[styles.fill, { width: `${percent}%`, backgroundColor: c.amber }]} />
            </View>
            <Pressable onPress={onCancel} accessibilityRole="button" accessibilityLabel="Cancel duplicate" hitSlop={8}>
              <Text style={[styles.cancel, { color: c.ink }]}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    )
  },
)

export function useDuplicateFile(opts: {
  /** "Show" on the success toast: take the person to the folder the copy is in. */
  onShow: (parentId: string | null) => void
  /** Called with the new entry, e.g. so a list can add the row. */
  onDuplicated?: (entry: FileEntry, name: string, parentId: string | null) => void
}) {
  const crypto = useCrypto()
  const { showToast } = useToast()
  const { colors: c } = useTheme()
  // Only the sheet's own state ticks with progress: the host screen (a long
  // list) re-renders when the sheet opens and closes, never per percent.
  const [activeName, setActiveName] = useState<string | null>(null)
  const sheetRef = useRef<ProgressSheetHandle>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
    }
  }, [])

  const duplicate = useCallback(async (source: DuplicateSource) => {
    if (controllerRef.current) {
      showToast({ type: 'info', message: 'A duplicate is already in progress.' })
      return
    }
    if (source.isFolder) {
      showToast({ type: 'info', message: "Folders can't be duplicated yet." })
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    // The sheet opens once the work starts: after the large-file question, never over it.
    if (!needsLargeFileConfirm(source.sizeBytes) && mountedRef.current) setActiveName(source.name)
    const confirmLarge = async (sizeBytes: number) => {
      const ok = await confirmLargeDuplicate(sizeBytes)
      if (ok && mountedRef.current) setActiveName(source.name)
      return ok
    }
    try {
      const result = await runDuplicate(source, crypto, confirmLarge, {
        signal: controller.signal,
        onProgress: (fraction) => sheetRef.current?.setPercent(Math.round(fraction * 100)),
      })
      if (!mountedRef.current) return
      setActiveName(null)
      optsRef.current.onDuplicated?.(result.entry, result.name, source.parentId)
      showToast({
        type: 'success',
        message: `Duplicated as ${result.name}`,
        action: {
          label: 'Show',
          onPress: () => {
            if (!mountedRef.current) return
            optsRef.current.onShow(source.parentId)
          },
        },
      })
    } catch (err) {
      if (!mountedRef.current) return
      setActiveName(null)
      if (err instanceof DuplicateCancelledError) return
      if (err instanceof DuplicateRefusedError) {
        showToast({ type: 'info', message: err.message })
        return
      }
      const quota = err instanceof ApiError && err.code === 'quota_exceeded'
      showToast({
        type: 'error',
        message: quota ? friendlyError(err) : `Couldn't duplicate: ${friendlyError(err)}`,
      })
    } finally {
      controllerRef.current = null
    }
  }, [crypto, showToast])

  const cancel = useCallback(() => controllerRef.current?.abort(), [])

  const progressSheet = activeName ? (
    <DuplicateProgressSheet ref={sheetRef} name={activeName} onCancel={cancel} />
  ) : null

  return { duplicate, progressSheet }
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 340, borderRadius: 14, borderWidth: 1, padding: 18, gap: 10 },
  title: { fontSize: 16, fontWeight: '600' },
  name: { fontSize: 13 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  cancel: { fontSize: 15, fontWeight: '600', textAlign: 'center', paddingTop: 6 },
})
