// @ts-nocheck
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const engine = readFileSync(
  join(import.meta.dir, '../../modules/beebeeb-crypto/ios/NativeBackupEngine.swift'),
  'utf8',
);
const moduleSwift = readFileSync(
  join(import.meta.dir, '../../modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift'),
  'utf8',
);
const bridge = readFileSync(
  join(import.meta.dir, '../../modules/beebeeb-crypto/src/BeebeebCrypto.ts'),
  'utf8',
);
const cascade = readFileSync(join(import.meta.dir, 'delete-cascade.ts'), 'utf8');

test('a resumed upload in Trash is restaged as a new live backup', () => {
  const resume = engine.slice(
    engine.indexOf('if isResumingExistingRemote {'),
    engine.indexOf('onFileStatus?(asset.localAssetId, "uploading"'),
  );
  expect(resume).toMatch(/case \.complete:\s*[\s\S]*markUploadComplete/);
  expect(resume).toMatch(/case \.completeInTrash, \.gone:\s*[\s\S]*clearStagedStateForRestage/);
  expect(resume).not.toMatch(/case \.complete, \.completeInTrash/);
});

test('requeueing an idle manifest wakes the native photo drain', () => {
  expect(engine).toMatch(/func wakeForManifestChange\(\) \{\s*wakeDrainLoop\(reason: "manifest-changed"\)/);
  expect(moduleSwift).toMatch(/AsyncFunction\("wakePhotoBackupDrain"\)[\s\S]*wakeForManifestChange\(\)/);
  expect(bridge).toMatch(/export async function wakePhotoBackupDrain\(\)/);
  expect(cascade).toMatch(/if \(requeued > 0\) await wakePhotoBackupDrain\(\)/);
});
