// @ts-nocheck
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('the device-owner prompt uses the guarded biometric-first device-owner options', () => {
  const source = readFileSync(join(import.meta.dir, 'device-owner-auth.ts'), 'utf8');
  expect(source).toContain('deviceOwnerAuthOptions');
  expect(source).not.toContain('disableDeviceFallback: false');
  expect(source).toContain('const refreshedProbe = await probeDeviceOwnerAuth(true)');
  expect(source).toContain('authState: settledProbe.state');
  expect(source).toContain('DEVICE_OWNER_AUTH_ATTEMPTED_KEY');
  expect(source).toContain('reliable: false');
  expect(source).toContain('refreshedProbe.reliable ? refreshedProbe : probe');

  const prompt = source.slice(source.indexOf('export async function requestDeviceOwnerAuth'));
  expect(prompt.indexOf('await LocalAuthentication.authenticateAsync')).toBeGreaterThan(-1);
  expect(prompt.indexOf('await markDeviceOwnerAuthAttempted()')).toBeGreaterThan(
    prompt.indexOf('await LocalAuthentication.authenticateAsync'),
  );
  expect(prompt).not.toContain('void markDeviceOwnerAuthAttempted()');
});

test('the launch lock probes blocked Face ID and surfaces the native blocked outcome', () => {
  const lockScreen = readFileSync(join(import.meta.dir, '../screens/BiometricLockScreen.tsx'), 'utf8');
  const crypto = readFileSync(join(import.meta.dir, 'crypto-context.tsx'), 'utf8');
  expect(lockScreen).toContain('getDeviceOwnerAuthState');
  expect(lockScreen).toContain('Linking.openSettings');
  expect(lockScreen).toContain("AppState.addEventListener('change'");
  expect(lockScreen).toContain('if (outcome.nativeFaceAuthConfirmed)');
  expect(lockScreen).toContain('await markDeviceOwnerAuthAttempted()');
  const app = readFileSync(join(import.meta.dir, '../App.tsx'), 'utf8');
  expect(app).toContain('PASSCODE_MIGRATION_KEY');
  expect(app).toContain('accessControlAlreadyCurrent');
  expect(app).toContain('nativeVaultAuthConfirmsFace');
  expect(crypto).toContain("case 'ERR_VAULT_AUTH_NOT_AVAILABLE'");
});

test('successful unlock dismisses the lock before optional post-unlock housekeeping', () => {
  const app = readFileSync(join(import.meta.dir, '../App.tsx'), 'utf8');
  const handler = app.slice(app.indexOf('async function handleUnlocked'), app.indexOf('if (!locked) return null'));
  expect(handler.indexOf('onUnlock();')).toBeGreaterThan(0);
  expect(handler.indexOf('onUnlock();')).toBeLessThan(handler.indexOf('getToken()'));
  expect(handler).toContain('void (async () =>');
});

test('an indeterminate probe keeps the wizard CTA Face-first', () => {
  const wizard = readFileSync(join(import.meta.dir, '../screens/FirstRunSetupScreen.tsx'), 'utf8');
  expect(wizard).toContain("state?.kind === 'indeterminate'");
  expect(wizard).toContain("indeterminate ? 'Try Face ID'");
});
