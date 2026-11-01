import { BBLogo } from "../components/BBLogo";
import { BBWordmark } from "../components/BBWordmark";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';
import { useTheme } from '../lib/theme-context';
import { requestConfirmation } from '../lib/confirm-action';
import { markUnlocked } from '../lib/lock-state';
import {
  getDeviceOwnerAuthState,
  markDeviceOwnerAuthAttempted,
  requestDeviceOwnerAuth,
} from '../lib/device-owner-auth';
import type { DeviceOwnerAuthState } from '../lib/device-owner-auth-policy';

interface Props {
  /**
   * Perform the actual vault unlock (load the master key + warm caches) and
   * report whether the app may transition past the lock screen. On real
   * release builds the key load itself triggers the Secure-Enclave Face ID
   * prompt — that is THE biometric gate, so `requireExplicitBiometric` is
   * false and we do NOT prompt separately. Resolves `{ ok: false }` when the
   * biometric was cancelled / the key could not be loaded, so we stay locked.
   * `fallbackUnlock` is set by the password path; a key load that still fails
   * then routes to recovery instead of opening the app.
   */
  onUnlocked: (opts?: {
    fallbackUnlock?: boolean;
    softwareFallbackAuthenticated?: boolean;
  }) => Promise<{
    ok: boolean;
    nativeFaceAuthConfirmed: boolean;
    explicitDeviceAuthRequired: boolean;
  }>;
  /**
   * When true, the key load will NOT raise a biometric prompt (simulator /
   * Debug build, or the vault is already warm from a foreground re-lock), so
   * this screen must run its own device-owner authentication to enforce the
   * lock. When false, the Secure-Enclave decrypt inside
   * `onUnlocked()` is the single biometric — prompting here too would produce
   * the double Face ID prompt (task 0792).
   */
  requireExplicitBiometric: boolean;
}

function FaceIdIcon({ color }: { color: string }) {
  return (
    <View style={styles.svgContainer}>
      {/* Outer circle */}
      <View style={[styles.faceCircle, { borderColor: color }]}>
        {/* Eyes */}
        <View style={styles.eyes}>
          <View style={[styles.eye, { backgroundColor: color }]} />
          <View style={[styles.eye, { backgroundColor: color }]} />
        </View>
        {/* Smile arc — approximated with a border */}
        <View style={[styles.smile, { borderColor: color }]} />
      </View>
    </View>
  );
}

export default function BiometricLockScreen({ onUnlocked, requireExplicitBiometric }: Props) {
  // Block screenshots/screen recording while the app is locked — the lock
  // screen covers any sensitive content that was on-screen at lock time.
  usePreventScreenCapture('biometric-lock');
  const insets = useSafeAreaInsets();
  const { colors: c, resolved } = useTheme();
  const [authenticating, setAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authState, setAuthState] = useState<DeviceOwnerAuthState | null>(null);
  const autoPromptedRef = useRef(false);
  const openedSettingsRef = useRef(false);
  // Guards against a second concurrent prompt — the auto-prompt effect and a
  // user tap can otherwise both call authenticate(), stacking two Face ID
  // sheets. Cleared in the finally block once the first one settles.
  const inFlightRef = useRef(false);

  const authenticate = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    setAuthenticating(true);
    try {
      // This probe does not display an OS prompt. In particular, it catches
      // Face ID being disabled for Beebeeb before the native key load can
      // enter an opaque retry loop. A real-device cold unlock still performs
      // exactly one interactive evaluation below, inside `onUnlocked()`.
      const currentState = await getDeviceOwnerAuthState();
      setAuthState(currentState);
      if (!currentState.canAuthenticate) {
        setError(currentState.message);
        return;
      }

      // EXACTLY ONE biometric evaluation must occur (task 0792). Two cases:
      //
      //   1. requireExplicitBiometric — the vault key load will NOT prompt
      //      (simulator / Debug build, or the vault is already warm from a
      //      foreground re-lock). We must prompt here, and this is the gate.
      //   2. otherwise — the key load (`onUnlocked`) performs the
      //      Secure-Enclave Face ID decrypt; that IS the single prompt, so we
      //      do NOT prompt here. Prompting in both places is what produced the
      //      "succeeds but app doesn't open, then prompts again" double prompt.
      const authenticateDeviceOwner = async (): Promise<boolean> => {
        // One device-owner policy: iOS tries Face ID first and only offers the
        // iPhone passcode after Face ID does not match. A separate biometric-
        // only probe would create two LAContexts and can double-prompt. The
        // shared helper owns the `disableDeviceFallback: false` option.
        const result = await requestDeviceOwnerAuth('Unlock Beebeeb', {
          failed: 'Authentication failed. Tap Try Face ID to try again.',
        });
        setAuthState(result.authState);
        if (!result.ok) {
          if (result.reason !== 'cancelled') setError(result.message);
          return false;
        }
        return true;
      };

      let explicitAuthCompleted = false;
      if (requireExplicitBiometric) {
        explicitAuthCompleted = await authenticateDeviceOwner();
        if (!explicitAuthCompleted) return;
      }

      let outcome = await onUnlocked(
        explicitAuthCompleted ? { softwareFallbackAuthenticated: true } : undefined,
      );
      if (outcome.explicitDeviceAuthRequired) {
        // A physical-device SecureStore copy is a recovery path for a failed
        // Secure-Enclave write. It has no native ACL of its own, so authenticate
        // BEFORE asking the host to read it. The retry explicitly prefers that
        // copy, avoiding a second native Face ID sheet if a stale SE key exists.
        explicitAuthCompleted = await authenticateDeviceOwner();
        if (!explicitAuthCompleted) return;
        outcome = await onUnlocked({ softwareFallbackAuthenticated: true });
      }
      if (!outcome.ok) {
        // Key load failed (e.g. the Secure-Enclave biometric was cancelled).
        // Fail closed — stay locked and let the user retry. Never transition
        // without a successful biometric.
        // The native key-load error contract intentionally remains small at
        // this boundary. Re-probe after a failure so a newly blocked/off Face
        // ID permission gets the actionable Settings recovery instead of a
        // generic retry. This is noninteractive and cannot add another prompt.
        const failedState = await getDeviceOwnerAuthState();
        setAuthState(failedState);
        setError(
          failedState.openSettings
            ? failedState.message
            : 'Authentication failed. Tap Try Face ID to try again.',
        );
        return;
      }
      // A current-policy Release cold unlock authenticates inside the native
      // primary-key load, bypassing the JS prompt helper. Record that sheet so
      // later probes report the confirmed state. A one-time legacy strict-
      // passcode migration deliberately returns false here: it did not prove
      // Face ID consent.
      if (outcome.nativeFaceAuthConfirmed) {
        await markDeviceOwnerAuthAttempted();
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      setError('Could not access biometrics. Tap to try again.');
    } finally {
      setAuthenticating(false);
      inFlightRef.current = false;
    }
  }, [onUnlocked, requireExplicitBiometric]);

  const openSettings = useCallback(async () => {
    openedSettingsRef.current = true;
    try {
      await Linking.openSettings();
    } catch (caught) {
      openedSettingsRef.current = false;
      throw caught;
    }
  }, []);

  const unlockWithPassword = useCallback(async () => {
    const token = await requestConfirmation({
      title: 'Use your Beebeeb password',
      message: 'Enter your password to unlock Beebeeb on this device.',
    });
    if (!token) return;
    markUnlocked();
    // Password is the fallback when biometrics aren't working. If the key load
    // still fails, the host routes to recovery rather than opening the app.
    await onUnlocked({ fallbackUnlock: true });
  }, [onUnlocked]);

  // Auto-trigger on mount
  useEffect(() => {
    if (autoPromptedRef.current) return;
    autoPromptedRef.current = true;
    authenticate();
  }, [authenticate]);

  useEffect(() => {
    let live = true;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      void getDeviceOwnerAuthState().then((nextState) => {
        if (!live) return;
        setAuthState(nextState);
        if (openedSettingsRef.current) {
          openedSettingsRef.current = false;
          setError(nextState.openSettings ? nextState.message : null);
        } else if (nextState.openSettings) {
          setError(nextState.message);
        }
      });
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: c.amberBg, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        {/* Center section */}
        <View style={styles.center}>
          {/* Logo — wordmark omitted here because `styles.logo` is a fixed
              52x52 ink-colored frame that would clip the wordmark. */}
          <View style={[styles.logo, { backgroundColor: c.ink }]}>
            <BBLogo size={48} />
          </View>
          <BBWordmark size={22} style={{ marginTop: 12 }} />

          <Text style={[styles.title, { color: c.ink }]}>Beebeeb is locked</Text>
          <Text style={[styles.subtitle, { color: c.ink3 }]}>
            Your vault key lives only on this device. Unlock it with Face ID or your passcode. Nothing leaves the phone.
          </Text>

          {/* Face ID button */}
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={authenticate}
            disabled={authenticating}
            accessibilityRole="button"
            accessibilityLabel="Try Face ID"
            style={[styles.faceIdOuter, { shadowColor: c.amber }]}
          >
            <View style={[styles.faceIdInner, { backgroundColor: c.paper, borderColor: c.ink }]}>
              {authenticating ? (
                <ActivityIndicator size="large" color={c.ink} />
              ) : (
                <FaceIdIcon color={c.ink} />
              )}
            </View>
          </TouchableOpacity>

          <Text style={[styles.lookToUnlock, { color: c.ink3 }]}>
            {authenticating ? 'Authenticating...' : 'Look to unlock'}
          </Text>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          {error && (
            <View style={styles.errorRow}>
              <Text style={[styles.errorText, { color: c.red }]}>{error}</Text>
            </View>
          )}
          {authState?.openSettings && (
            <TouchableOpacity
              onPress={openSettings}
              disabled={authenticating}
              accessibilityRole="button"
              accessibilityLabel="Open iOS Settings"
              testID="app-lock-open-settings"
              style={[styles.settingsButton, { borderColor: c.ink }]}
            >
              <Text style={[styles.settingsButtonText, { color: c.ink }]}>Open Settings</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={authenticate}
            disabled={authenticating}
            accessibilityRole="button"
            accessibilityLabel="Try Face ID"
            testID="app-lock-unlock"
          >
            <Text style={[styles.footerText, { color: c.ink3 }]}>Try Face ID</Text>
          </TouchableOpacity>
          {/* Always offered: a cancelled prompt sets no error, and Face ID can stay unavailable. */}
          <TouchableOpacity
            onPress={unlockWithPassword}
            disabled={authenticating}
            accessibilityRole="button"
            accessibilityLabel="Use Beebeeb password"
            testID="app-lock-password"
            style={[styles.passwordButton, { borderColor: c.line, backgroundColor: c.paper }]}
          >
            <Text style={[styles.passwordButtonText, { color: c.ink }]}>Use Beebeeb password</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.amberBg,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  center: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },

  // Logo
  logo: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
    transform: [{ scale: 1.2 }],
  },
  logoText: {
    color: colors.amber,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.5,
  },

  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 6,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 13,
    color: colors.ink3,
    textAlign: 'center',
    maxWidth: 240,
    lineHeight: 19,
  },

  // Face ID button — ring with fill
  faceIdOuter: {
    marginTop: 40,
    width: 96,
    height: 96,
    borderRadius: 24,
    // Double ring via shadow (amber rings)
    shadowColor: colors.amber,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 12,
    elevation: 8,
  },
  faceIdInner: {
    width: 96,
    height: 96,
    borderRadius: 24,
    backgroundColor: colors.paper,
    borderWidth: 2,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // SVG-style face icon via pure RN views
  svgContainer: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyes: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
    marginTop: -2,
  },
  eye: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: colors.ink,
  },
  smile: {
    width: 14,
    height: 7,
    borderBottomLeftRadius: 7,
    borderBottomRightRadius: 7,
    borderWidth: 2,
    borderTopWidth: 0,
    borderColor: colors.ink,
  },

  lookToUnlock: {
    marginTop: 14,
    fontSize: 12,
    color: colors.ink3,
  },

  // Footer
  footer: {
    paddingHorizontal: 24,
    paddingBottom: 16,
    alignItems: 'center',
    gap: 8,
  },
  errorRow: {
    paddingVertical: 4,
  },
  errorText: {
    fontSize: 12,
    color: colors.red,
    textAlign: 'center',
  },
  footerText: {
    fontSize: 12,
    color: colors.ink3,
  },
  footerLink: {
    color: colors.amberDeep,
    fontWeight: '500',
  },
  passwordButton: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  passwordButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
  },
  settingsButton: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
  },
  settingsButtonText: {
    fontSize: 13,
    fontWeight: '700',
  },
});
