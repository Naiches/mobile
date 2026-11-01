export type DeviceBiometric = 'face' | 'fingerprint' | 'none';
export type DeviceOwnerSecurity = 'none' | 'passcode' | 'biometric';

export type DeviceOwnerAuthError =
  | 'not_enrolled'
  | 'user_cancel'
  | 'app_cancel'
  | 'not_available'
  | 'lockout'
  | 'timeout'
  | 'unable_to_process'
  | 'unknown'
  | 'system_cancel'
  | 'user_fallback'
  | 'invalid_context'
  | 'passcode_not_set'
  | 'authentication_failed'
  | 'missing_usage_description'
  | string;

export type DeviceOwnerAuthErrorPlan = 'cancel' | 'open-settings' | 'passcode-fallback' | 'fail';

export type DeviceOwnerAuthStateKind =
  | 'indeterminate'
  | 'face-id-on'
  | 'face-id-check'
  | 'face-id-off'
  | 'face-id-not-enrolled'
  | 'face-id-locked'
  | 'touch-id-on'
  | 'touch-id-check'
  | 'touch-id-off'
  | 'touch-id-not-enrolled'
  | 'touch-id-locked'
  | 'passcode-on'
  | 'unavailable';

export interface DeviceOwnerAuthState {
  kind: DeviceOwnerAuthStateKind;
  biometric: DeviceBiometric;
  canAuthenticate: boolean;
  openSettings: boolean;
  message: string;
}

export interface DeviceOwnerAuthSignals {
  biometric: DeviceBiometric;
  hardwareAvailable: boolean;
  security: DeviceOwnerSecurity;
  enrolled: boolean;
  /** False until Beebeeb has presented its first interactive device-owner sheet. */
  hasAttempted?: boolean;
  lastError?: DeviceOwnerAuthError;
}

export interface DeviceOwnerAuthOptions {
  promptMessage: string;
  cancelLabel: string;
  fallbackLabel: string;
  disableDeviceFallback: boolean;
}

export function deviceOwnerAuthOptions(promptMessage: string): DeviceOwnerAuthOptions {
  return {
    promptMessage,
    cancelLabel: 'Cancel',
    fallbackLabel: 'Use iPhone passcode',
    disableDeviceFallback: false,
  };
}

/**
 * A bridge timeout is not evidence that device security is absent. Keep the
 * native device-owner policy available and avoid false Settings guidance;
 * the interactive OS result remains authoritative.
 */
export function indeterminateDeviceOwnerAuthState(): DeviceOwnerAuthState {
  return {
    kind: 'indeterminate',
    biometric: 'none',
    canAuthenticate: true,
    openSettings: false,
    message: 'Check Face ID or your iPhone passcode to continue.',
  };
}

export function deviceOwnerAuthErrorPlan(error: DeviceOwnerAuthError): DeviceOwnerAuthErrorPlan {
  if (error === 'user_cancel' || error === 'system_cancel' || error === 'app_cancel') return 'cancel';
  if (error === 'not_available' || error === 'not_enrolled' || error === 'missing_usage_description' || error === 'passcode_not_set') {
    return 'open-settings';
  }
  // The one combined OS policy already owns Face ID → passcode sequencing.
  // A completed mismatch or fallback result is therefore a retry, not a cue
  // for the app to create a second authentication context.
  if (error === 'lockout') return 'passcode-fallback';
  return 'fail';
}

function biometricState(
  biometric: Exclude<DeviceBiometric, 'none'>,
  suffix: 'on' | 'check' | 'off' | 'not-enrolled' | 'locked',
): DeviceOwnerAuthState {
  const face = biometric === 'face';
  const name = face ? 'Face ID' : 'Touch ID';
  const kind = `${face ? 'face-id' : 'touch-id'}-${suffix}` as DeviceOwnerAuthStateKind;
  if (suffix === 'on') {
    return {
      kind,
      biometric,
      canAuthenticate: true,
      openSettings: false,
      message: `${name} is on for Beebeeb. Your iPhone passcode is available after ${name} does not match.`,
    };
  }
  if (suffix === 'check') {
    return {
      kind,
      biometric,
      canAuthenticate: true,
      openSettings: false,
      message: `Check ${name} now. If it is off for Beebeeb, iOS Settings can turn it back on.`,
    };
  }
  if (suffix === 'locked') {
    return {
      kind,
      biometric,
      canAuthenticate: true,
      openSettings: false,
      message: `${name} is temporarily locked. Use your iPhone passcode once, then try again.`,
    };
  }
  if (suffix === 'not-enrolled') {
    return {
      kind,
      biometric,
      canAuthenticate: false,
      openSettings: true,
      message: `Set up ${name} in iOS Settings, then come back to Beebeeb.`,
    };
  }
  return {
    kind,
    biometric,
    canAuthenticate: false,
    openSettings: true,
    message: `${name} is off for Beebeeb or unavailable. Turn it on in iOS Settings.`,
  };
}

export function deviceOwnerAuthState(signals: DeviceOwnerAuthSignals): DeviceOwnerAuthState {
  const { biometric, hardwareAvailable, security, enrolled, hasAttempted, lastError } = signals;
  if (lastError === 'passcode_not_set') {
    return {
      kind: 'unavailable',
      biometric,
      canAuthenticate: false,
      openSettings: true,
      message: 'Set an iPhone passcode in iOS Settings, then come back to Beebeeb.',
    };
  }
  if (biometric !== 'none') {
    if (lastError === 'not_available' || lastError === 'missing_usage_description') {
      return biometricState(biometric, 'off');
    }
    if (lastError === 'not_enrolled') return biometricState(biometric, 'not-enrolled');
    if (lastError === 'lockout') return biometricState(biometric, 'locked');
    if (!hardwareAvailable) return biometricState(biometric, 'off');
    if (!enrolled) return biometricState(biometric, 'not-enrolled');
    if (biometric === 'face' && hasAttempted === false) return biometricState(biometric, 'check');
    if (security === 'biometric' && enrolled) return biometricState(biometric, 'on');
    return biometricState(biometric, 'locked');
  }
  if (security === 'passcode' || security === 'biometric') {
    return {
      kind: 'passcode-on',
      biometric,
      canAuthenticate: true,
      openSettings: false,
      message: 'Your iPhone passcode protects Beebeeb on this device.',
    };
  }
  return {
    kind: 'unavailable',
    biometric,
    canAuthenticate: false,
    openSettings: true,
    message: 'Set up Face ID or an iPhone passcode in iOS Settings.',
  };
}
