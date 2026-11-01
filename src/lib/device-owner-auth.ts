import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { markUnlocked } from './lock-state';
import {
  deviceOwnerAuthErrorPlan,
  deviceOwnerAuthOptions,
  deviceOwnerAuthState,
  indeterminateDeviceOwnerAuthState,
  type DeviceBiometric,
  type DeviceOwnerAuthError,
  type DeviceOwnerAuthSignals,
  type DeviceOwnerAuthState,
  type DeviceOwnerSecurity,
} from './device-owner-auth-policy';

export type DeviceOwnerAuthResult =
  | {
      ok: true;
      method: 'device_owner' | 'device_passcode';
      platform: 'ios' | 'android';
      authState: DeviceOwnerAuthState;
    }
  | {
      ok: false;
      reason: 'cancelled' | 'unavailable' | 'failed';
      message: string;
      authState: DeviceOwnerAuthState;
    };

interface DeviceOwnerAuthMessages {
  unavailable?: string;
  cancelled?: string;
  failed?: string;
}

function biometricFromTypes(types: LocalAuthentication.AuthenticationType[]): DeviceBiometric {
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'face';
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'fingerprint';
  return 'none';
}

function securityFromLevel(level: LocalAuthentication.SecurityLevel): DeviceOwnerSecurity {
  if (level === LocalAuthentication.SecurityLevel.NONE) return 'none';
  if (level === LocalAuthentication.SecurityLevel.SECRET) return 'passcode';
  return 'biometric';
}

interface DeviceOwnerAuthProbe {
  signals: DeviceOwnerAuthSignals;
  state: DeviceOwnerAuthState;
  reliable: boolean;
}

const DEVICE_OWNER_PROBE_TIMEOUT_MS = 5_000;
export const DEVICE_OWNER_AUTH_ATTEMPTED_KEY = 'beebeeb_device_owner_auth_attempted_v1';

interface RawDeviceOwnerAuthSignals {
  level: LocalAuthentication.SecurityLevel;
  types: LocalAuthentication.AuthenticationType[];
  hardwareAvailable: boolean;
  enrolled: boolean;
  hasAttempted: boolean;
}

async function probeSignals(): Promise<RawDeviceOwnerAuthSignals> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Device authentication state check timed out')), DEVICE_OWNER_PROBE_TIMEOUT_MS);
  });
  try {
    const [level, types, hardwareAvailable, enrolled, attempted] = await Promise.race([
      Promise.all([
        LocalAuthentication.getEnrolledLevelAsync(),
        LocalAuthentication.supportedAuthenticationTypesAsync(),
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
        SecureStore.getItemAsync(DEVICE_OWNER_AUTH_ATTEMPTED_KEY).catch(() => null),
      ]),
      timeout,
    ]);
    return { level, types, hardwareAvailable, enrolled, hasAttempted: attempted === '1' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeDeviceOwnerAuth(hasAttemptedOverride?: boolean): Promise<DeviceOwnerAuthProbe> {
  try {
    const raw = await probeSignals();
    const signals: DeviceOwnerAuthSignals = {
      biometric: biometricFromTypes(raw.types),
      hardwareAvailable: raw.hardwareAvailable,
      security: securityFromLevel(raw.level),
      enrolled: raw.enrolled,
      hasAttempted: hasAttemptedOverride ?? raw.hasAttempted,
    };
    return { signals, state: deviceOwnerAuthState(signals), reliable: true };
  } catch {
    const signals: DeviceOwnerAuthSignals = {
      biometric: 'none',
      hardwareAvailable: false,
      security: 'none',
      enrolled: false,
      hasAttempted: hasAttemptedOverride ?? false,
    };
    return { signals, state: indeterminateDeviceOwnerAuthState(), reliable: false };
  }
}

export async function getDeviceOwnerAuthState(): Promise<DeviceOwnerAuthState> {
  return (await probeDeviceOwnerAuth()).state;
}

/** Record that Beebeeb presented an interactive device-owner sheet. */
export async function markDeviceOwnerAuthAttempted(): Promise<void> {
  await SecureStore.setItemAsync(DEVICE_OWNER_AUTH_ATTEMPTED_KEY, '1').catch(() => {});
}

export async function requestDeviceOwnerAuth(
  promptMessage: string,
  messages: DeviceOwnerAuthMessages = {},
): Promise<DeviceOwnerAuthResult> {
  const platform = Platform.OS === 'android' ? 'android' : 'ios';
  const probe = await probeDeviceOwnerAuth();
  if (!probe.state.canAuthenticate) {
    return {
      ok: false,
      reason: 'unavailable',
      message: probe.state.message || messages.unavailable || 'Device authentication is unavailable.',
      authState: probe.state,
    };
  }

  try {
    // Expo 57 maps this to LAPolicy.deviceOwnerAuthentication on iOS. Apple
    // presents enrolled biometrics first and only then offers the device
    // passcode. Keeping this as one LAContext avoids a double Face ID prompt.
    // Expo does not expose the per-app Face ID consent state before the first
    // sheet. Persist only after the native call settles: a synchronous bridge
    // failure cannot then claim that Beebeeb presented an OS sheet.
    const result = await LocalAuthentication.authenticateAsync(deviceOwnerAuthOptions(promptMessage));
    await markDeviceOwnerAuthAttempted();
    if (!result.success) {
      const error = result.error as DeviceOwnerAuthError;
      const plan = deviceOwnerAuthErrorPlan(error);
      const authState = probe.reliable || plan === 'open-settings'
        ? deviceOwnerAuthState({ ...probe.signals, hasAttempted: true, lastError: error })
        : indeterminateDeviceOwnerAuthState();
      if (plan === 'cancel') {
        return {
          ok: false,
          reason: 'cancelled',
          message: messages.cancelled ?? 'Authentication cancelled.',
          authState,
        };
      }
      if (plan === 'open-settings') {
        return {
          ok: false,
          reason: 'unavailable',
          message: authState.message || messages.unavailable || 'Device authentication is unavailable.',
          authState,
        };
      }
      return {
        ok: false,
        reason: 'failed',
        message: plan === 'passcode-fallback'
          ? authState.message
          : messages.failed ?? 'Authentication failed. Try again.',
        authState,
      };
    }

    markUnlocked();
    // The first Face ID sheet can change per-app consent. If the user denies
    // Face ID and succeeds with the iPhone passcode, the preflight probe is
    // stale; report the state that is true after the completed OS policy.
    const refreshedProbe = await probeDeviceOwnerAuth(true);
    const settledProbe = refreshedProbe.reliable ? refreshedProbe : probe;
    return {
      ok: true,
      // Expo reports that the device owner authenticated, not which
      // credential won. Never infer Face ID merely from hardware presence.
      method: settledProbe.reliable && settledProbe.state.biometric === 'none' ? 'device_passcode' : 'device_owner',
      platform,
      authState: settledProbe.state,
    };
  } catch {
    return {
      ok: false,
      reason: 'failed',
      message: messages.failed ?? 'Could not complete device authentication. Try again.',
      authState: probe.state,
    };
  }
}
