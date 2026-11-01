// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  deviceOwnerAuthErrorPlan,
  deviceOwnerAuthOptions,
  deviceOwnerAuthState,
  indeterminateDeviceOwnerAuthState,
} from './device-owner-auth-policy';

describe('device-owner authentication policy', () => {
  test('uses the Apple device-owner policy: biometric first, then iPhone passcode fallback', () => {
    expect(deviceOwnerAuthOptions('Try Face ID')).toEqual({
      promptMessage: 'Try Face ID',
      cancelLabel: 'Cancel',
      fallbackLabel: 'Use iPhone passcode',
      disableDeviceFallback: false,
    });
  });

  test('the combined policy owns fallback; completed failures ask for a retry', () => {
    expect(deviceOwnerAuthErrorPlan('authentication_failed')).toBe('fail');
    expect(deviceOwnerAuthErrorPlan('lockout')).toBe('passcode-fallback');
    expect(deviceOwnerAuthErrorPlan('user_fallback')).toBe('fail');
    expect(deviceOwnerAuthErrorPlan('user_cancel')).toBe('cancel');
    expect(deviceOwnerAuthErrorPlan('not_available')).toBe('open-settings');
    expect(deviceOwnerAuthErrorPlan('not_enrolled')).toBe('open-settings');
  });

  test('maps Face ID on, unconfirmed, off, not enrolled and locked states', () => {
    const faceSignals = { biometric: 'face' as const, hardwareAvailable: true, security: 'biometric' as const, enrolled: true };
    expect(deviceOwnerAuthState(faceSignals)).toMatchObject({ kind: 'face-id-on', canAuthenticate: true, openSettings: false });
    expect(deviceOwnerAuthState({ ...faceSignals, hasAttempted: false })).toMatchObject({ kind: 'face-id-check', canAuthenticate: true, openSettings: false });
    expect(deviceOwnerAuthState({ ...faceSignals, security: 'passcode', enrolled: true })).toMatchObject({ kind: 'face-id-locked', canAuthenticate: true, openSettings: false });
    expect(deviceOwnerAuthState({ ...faceSignals, enrolled: false })).toMatchObject({ kind: 'face-id-not-enrolled', canAuthenticate: false, openSettings: true });
    expect(deviceOwnerAuthState({ ...faceSignals, hardwareAvailable: false })).toMatchObject({ kind: 'face-id-off', canAuthenticate: false, openSettings: true });
    expect(deviceOwnerAuthState({ ...faceSignals, lastError: 'not_available' })).toMatchObject({ kind: 'face-id-off', canAuthenticate: false, openSettings: true });
    expect(deviceOwnerAuthState({ ...faceSignals, lastError: 'not_enrolled' })).toMatchObject({ kind: 'face-id-not-enrolled', canAuthenticate: false, openSettings: true });
    expect(deviceOwnerAuthState({ ...faceSignals, lastError: 'lockout' })).toMatchObject({ kind: 'face-id-locked', canAuthenticate: true, openSettings: false });
  });

  test('maps passcode, Touch ID, and missing device security without claiming Face ID', () => {
    expect(deviceOwnerAuthState({ biometric: 'none', hardwareAvailable: true, security: 'passcode', enrolled: true })).toMatchObject({
      kind: 'passcode-on', biometric: 'none', canAuthenticate: true, openSettings: false,
    });
    expect(deviceOwnerAuthState({ biometric: 'fingerprint', hardwareAvailable: true, security: 'biometric', enrolled: true })).toMatchObject({
      kind: 'touch-id-on', biometric: 'fingerprint', canAuthenticate: true, openSettings: false,
    });
    expect(deviceOwnerAuthState({ biometric: 'none', hardwareAvailable: false, security: 'none', enrolled: false })).toMatchObject({
      kind: 'unavailable', canAuthenticate: false, openSettings: true,
    });
  });

  test('a passcode-not-set result is unavailable even when biometric probes looked healthy', () => {
    expect(deviceOwnerAuthState({
      biometric: 'face', hardwareAvailable: true, security: 'biometric', enrolled: true, lastError: 'passcode_not_set',
    })).toMatchObject({ kind: 'unavailable', canAuthenticate: false, openSettings: true });
  });

  test('a failed capability probe stays indeterminate and does not block the native policy', () => {
    expect(indeterminateDeviceOwnerAuthState()).toMatchObject({
      kind: 'indeterminate',
      canAuthenticate: true,
      openSettings: false,
    });
  });
});
