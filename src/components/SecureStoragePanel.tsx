import React, { useEffect, useRef } from 'react'
import { AppState, Platform, ScrollView, Text, TouchableOpacity, useWindowDimensions } from 'react-native'
import { useTheme } from '../lib/theme-context'
import { secureStorageUnavailableCopy } from '../lib/startup-auth'

interface Props {
  onRetry: () => void
}

/**
 * Startup fallback when the session-token read from the device's secure
 * storage threw (Keychain locked before first unlock, a protected-data race,
 * a build without keychain access). The network is not involved, so this
 * deliberately does NOT run the server diagnostics: telling the user "Couldn't
 * reach our servers" here would be false.
 */
export function SecureStoragePanel({ onRetry }: Props) {
  const { colors: c } = useTheme()
  const { fontScale } = useWindowDimensions()
  const accessibilityLayout = fontScale >= 1.3
  const copy = secureStorageUnavailableCopy(Platform.OS)
  const appState = useRef(AppState.currentState)

  // The usual cause is a locked device; retry by itself the moment the app
  // comes back to the foreground after the user unlocks.
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      const wasBackground = appState.current !== 'active'
      appState.current = next
      if (wasBackground && next === 'active') onRetry()
    })
    return () => sub.remove()
  }, [onRetry])

  return (
    <ScrollView
      testID="startup-secure-storage-error"
      style={{ width: '100%', flexShrink: 1 }}
      contentContainerStyle={{ paddingHorizontal: 32, alignItems: 'center' }}
      showsVerticalScrollIndicator={accessibilityLayout}
    >
      <Text style={{ color: c.ink, fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 8 }}>
        {copy.title}
      </Text>
      <Text style={{ color: c.ink3, fontSize: 13, textAlign: 'center', lineHeight: 18, maxWidth: 320 }}>
        {copy.body}
      </Text>

      <TouchableOpacity
        testID="startup-secure-storage-retry"
        onPress={onRetry}
        style={{ marginTop: 24, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, backgroundColor: c.amber, minHeight: accessibilityLayout ? 48 : undefined, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text style={{ color: '#1a1a2e', fontSize: 14, fontWeight: '600' }}>Try again</Text>
      </TouchableOpacity>
    </ScrollView>
  )
}
