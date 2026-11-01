// @ts-nocheck
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('the primary vault key allows Face ID first with the device passcode as fallback', () => {
  const source = readFileSync(
    join(import.meta.dir, '../../modules/beebeeb-crypto/ios/KeychainManager.swift'),
    'utf8',
  );
  const primaryFactory = source.slice(
    source.indexOf('private static func getOrCreateSEKey()'),
    source.indexOf('private static func getOrCreateExtensionSEKey()'),
  );
  expect(primaryFactory).toContain('[.privateKeyUsage, .userPresence]');
  expect(primaryFactory).not.toContain('[.privateKeyUsage, .devicePasscode]');

  const accessControlMigration = source.slice(
    source.indexOf('static func setAccessControl(requireBiometric: Bool)'),
    source.indexOf('static func replaceAccessControl(requireBiometric: Bool'),
  );
  expect(accessControlMigration).toContain('[.privateKeyUsage, .userPresence]');
  expect(accessControlMigration).not.toContain('[.privateKeyUsage, .devicePasscode]');

  const extensionFactory = source.slice(
    source.indexOf('private static func getOrCreateExtensionSEKey()'),
    source.indexOf('private static func getOrCreateFileProviderSEKey()'),
  );
  expect(extensionFactory).toContain('[.privateKeyUsage, .devicePasscode]');
});

test('the primary vault load uses one Face ID-first context and reuses it for decryption', () => {
  const source = readFileSync(
    join(import.meta.dir, '../../modules/beebeeb-crypto/ios/KeychainManager.swift'),
    'utf8',
  );
  const primaryAuthentication = source.slice(
    source.indexOf('private static func authenticateForPrimaryLoad(label: String)'),
    source.indexOf('private static func classifyLAError'),
  );
  expect(primaryAuthentication.match(/LAContext\(\)/g)).toHaveLength(1);
  expect(primaryAuthentication).not.toContain('touchIDAuthenticationAllowableReuseDuration');
  expect(primaryAuthentication).toContain('.deviceOwnerAuthentication');
  expect(primaryAuthentication).toContain('context.localizedFallbackTitle = "Use iPhone passcode"');
  expect(primaryAuthentication.match(/context\.evaluatePolicy\(/g)).toHaveLength(1);
  expect(primaryAuthentication).toContain('semaphore.wait(timeout:');
  expect(primaryAuthentication).toContain('context.invalidate()');
  expect(primaryAuthentication).toContain('return context');

  const primaryLoad = source.slice(
    source.indexOf('static func load(label: String)'),
    source.indexOf('// MARK: - Primary-load biometric evaluation'),
  );
  expect(primaryLoad).toContain('authContext: authContext');
  expect(primaryLoad.match(/authenticateForPrimaryLoad\(label: label\)/g)).toHaveLength(1);
  expect(primaryLoad).toContain('decryptRetryDelays');
  expect(primaryLoad).toContain('reason == .notWarm');
  expect(primaryLoad).toContain('repairInterruptedAccessControlMigration');
  expect(primaryLoad).toContain('legacyDevicePasscode');
  expect(primaryLoad).toContain('if legacyPrimaryAccessControl');
  expect(primaryLoad).toContain('replaceAccessControl(requireBiometric: false');
});

test('access-control replacement never deletes the extension and Files recovery copies', () => {
  const source = readFileSync(
    join(import.meta.dir, '../../modules/beebeeb-crypto/ios/KeychainManager.swift'),
    'utf8',
  );
  const replacement = source.slice(
    source.indexOf('static func replaceAccessControl(requireBiometric: Bool'),
    source.indexOf('// MARK: - Arbitrary string storage'),
  );
  expect(replacement).not.toContain('deleteSEKey()');
  expect(replacement).not.toContain('deleteWrappedItems()');
  expect(replacement).toContain('deleteSEKey(tag: BeebeebKeychainCore.seKeyTag)');
  expect(replacement).toContain('deleteWrappedItem(account: label)');
  expect(replacement).toContain('beginAccessControlMigration(targetBiometric: requireBiometric)');
  expect(replacement).toContain('finishAccessControlMigration()');
  expect(replacement).toContain('storePrimaryWrappedKey(masterKeyBytes: masterKeyBytes, label: label)');
  expect(replacement).not.toContain('try store(masterKeyBytes: masterKeyBytes, label: label)');
});

test('old device-passcode keys reuse one implicit context across cold-SE retries before rewrap', () => {
  const source = readFileSync(
    join(import.meta.dir, '../../modules/beebeeb-crypto/ios/KeychainManager.swift'),
    'utf8',
  );
  expect(source).toContain('primaryAccessControlVersionKey');
  expect(source).toContain('authContext = LAContext()');
  expect(source).toContain('authContext.localizedFallbackTitle = "Use iPhone passcode"');
  expect(source).toContain('authContext = try authenticateForPrimaryLoad(label: label)');
  expect(source).not.toContain('legacyDevicePasscode ? nil : try authenticateForPrimaryLoad');
  expect(source).toContain('let decryptRetryDelays: [TimeInterval] = [0.3, 0.5, 0.8, 1.2, 1.8]');
  expect(source).not.toContain('legacyDevicePasscode ? []');
});
