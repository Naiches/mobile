// @ts-nocheck
// Source-level guards for the app lock wiring (App.tsx, lock screen, Settings).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) => readFileSync(join(import.meta.dir, '..', rel), 'utf8');
const app = read('App.tsx');
const lockScreen = read('screens/BiometricLockScreen.tsx');
const settings = read('screens/SettingsScreen.tsx');
const crypto = read('lib/crypto-context.tsx');
const nativeBridge = read('../modules/beebeeb-crypto/src/BeebeebCrypto.ts');
const nativeModule = read('../modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift');
const keychain = read('../modules/beebeeb-crypto/ios/KeychainManager.swift');

describe('App.tsx', () => {
  test('has no silent cold-launch unlock with a swallowed error', () => {
    expect(app).not.toContain('cold_launch_vault_unlock');
    expect(app).not.toContain('silentUnlockDone');
  });

  test('a restored session stays opaque until the lock decision belongs to that user', () => {
    expect(app).toContain('lockDecisionUserId === user.user_id');
    expect(app).toMatch(/checking\s*\|\|[\s\S]{0,120}!startupLockChecked/);
    expect(app).not.toContain('setStartupLockChecked(true)');
  });

  test('takes the lock decisions from the shared policy', () => {
    expect(app).toContain("from './lib/app-lock-policy'");
    expect(app).toContain('shouldLockAtLaunch');
    expect(app).toContain('shouldRelockOnReturn');
    expect(app).toContain('classifyKeyLoad');
    expect(app).not.toMatch(/const BIOMETRIC_PREF_KEY/);
    expect(app).not.toMatch(/pref === 'true'/);
  });

  test('runs the passcode key migration after an unlock', () => {
    expect(app).toContain('runPasscodeKeyMigration');
  });

  test('the password fallback no longer opens the app on a failed key load', () => {
    expect(app).not.toMatch(/if \(!fallbackUnlock && !missingKey\)/);
  });

  test('a physical software vault authenticates before reading the key and skips a second native prompt', () => {
    expect(app).toContain('physicalVaultUsesSoftwareFallback');
    expect(app).toContain('softwareFallbackUnlockPlan');
    expect(app).toContain("softwareFallbackPlan === 'authenticate'");
    expect(app).toContain("preferSoftwareFallback: softwareFallbackPlan === 'prefer-fallback'");
    expect(lockScreen).toContain('outcome.explicitDeviceAuthRequired');
    expect(lockScreen).toContain('softwareFallbackAuthenticated: true');
    expect(crypto).toContain('if (!preferSoftwareFallback && !usesSoftwareVaultFallback())');
    expect(crypto).toContain('deleteItemAsync(MASTER_KEY_FALLBACK_LABEL)');

    const unlockHandler = app.slice(
      app.indexOf('async function handleUnlocked'),
      app.indexOf('if (!locked) return null'),
    );
    expect(unlockHandler).toContain('precheckKeyOwner(userId)');
    expect(unlockHandler).toContain('MASTER_KEY_CHECK_LABEL');
    expect(unlockHandler.indexOf('precheckKeyOwner(userId)')).toBeLessThan(
      unlockHandler.indexOf('physicalVaultUsesSoftwareFallback()'),
    );
    expect(unlockHandler.indexOf('MASTER_KEY_CHECK_LABEL')).toBeLessThan(
      unlockHandler.indexOf('physicalVaultUsesSoftwareFallback()'),
    );
  });

  test('physical fallback preflight checks metadata without returning the master key to JS', () => {
    const preflight = crypto.slice(
      crypto.indexOf('export async function physicalVaultUsesSoftwareFallback'),
      crypto.indexOf('function uint8ToBase64'),
    );
    const iosPreflight = preflight.slice(
      preflight.indexOf("if (Platform.OS === 'ios')"),
      preflight.indexOf('// Android'),
    );
    expect(preflight).toContain('SharedNative.secureStoreItemExistsWithoutReadingData(MASTER_KEY_FALLBACK_LABEL)');
    expect(iosPreflight).not.toContain('SecureStore.getItemAsync(MASTER_KEY_FALLBACK_LABEL)');
    expect(nativeBridge).toContain('secureStoreItemExistsWithoutReadingData');
    expect(nativeModule).toContain('KeychainManager.secureStoreItemExistsWithoutReadingData');
    expect(keychain).toContain('static func secureStoreItemExistsWithoutReadingData');
    expect(keychain).toContain('interactionNotAllowed = true');
    expect(keychain).toContain('kSecUseAuthenticationContext');
    expect(keychain).not.toContain('kSecUseAuthenticationUIFail');
  });
});

describe('lock screen', () => {
  test('the Beebeeb password option is always offered, not only after an error', () => {
    // A cancelled prompt sets no error, so a password button behind `error &&`
    // left no way in after cancelling Face ID.
    const footer = lockScreen.slice(lockScreen.indexOf('{/* Footer */}'));
    const button = footer.slice(0, footer.indexOf('Use Beebeeb password'));
    const lastOpen = button.lastIndexOf('<TouchableOpacity');
    expect(lastOpen).toBeGreaterThan(-1);
    expect(button.slice(button.lastIndexOf('{', lastOpen), lastOpen)).not.toMatch(/error\s*&&/);
  });

  test('the explicit prompt allows the device passcode fallback', () => {
    expect(lockScreen).not.toContain('disableDeviceFallback: true');
    expect(lockScreen).toContain('disableDeviceFallback: false');
  });

  test('the prominent Face ID control is labelled for VoiceOver', () => {
    const prominent = lockScreen.slice(lockScreen.indexOf('{/* Face ID button */}'), lockScreen.indexOf('{/* Footer */}'));
    expect(prominent).toContain('accessibilityRole="button"');
    expect(prominent).toContain('accessibilityLabel="Try Face ID"');
  });
});

describe('Settings', () => {
  test('no longer switches the key to Face-ID-only', () => {
    expect(settings).not.toContain('setBiometricRequirement(true)');
  });

  test('turning the lock off, or a longer delay, goes through requestDeviceOwnerAuth', () => {
    expect(settings).toContain("from '../lib/device-owner-auth'");
    expect(settings).toContain('requestDeviceOwnerAuth');
    expect(settings).toContain('settingChangeNeedsAuth');
  });

  test('uses the shared storage keys and calls the concept "App lock"', () => {
    expect(settings).not.toMatch(/const BIOMETRIC_PREF_KEY/);
    expect(settings).toContain('label="App lock"');
    expect(settings).not.toContain('label="Biometric lock"');
  });
});
