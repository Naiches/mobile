// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  previewCompareIdentifier,
  previewPrimaryAction,
  previewSupportState,
  previewStorageAddition,
} from './photo-preview-screen-state';

describe('previewPrimaryAction', () => {
  test('offers Save while photo scope or samples are still loading', () => {
    expect(previewPrimaryAction({ controlsReady: true, working: false, enabled: true, scopeReady: false, applyCount: 0 })).toBe('save');
  });

  test('shows no redundant Save action once the setting is in effect and there is nothing to apply', () => {
    expect(previewPrimaryAction({ controlsReady: true, working: false, enabled: true, scopeReady: true, applyCount: 0 })).toBe('none');
  });

  test('offers Apply as soon as an actionable photo is known', () => {
    expect(previewPrimaryAction({ controlsReady: true, working: false, enabled: true, scopeReady: false, applyCount: 1 })).toBe('apply');
  });

  test('disables only for unavailable settings, off, or work in progress', () => {
    expect(previewPrimaryAction({ controlsReady: false, working: false, enabled: true, scopeReady: true, applyCount: 1 })).toBe('disabled');
    expect(previewPrimaryAction({ controlsReady: true, working: false, enabled: false, scopeReady: true, applyCount: 1 })).toBe('disabled');
    expect(previewPrimaryAction({ controlsReady: true, working: true, enabled: true, scopeReady: true, applyCount: 1 })).toBe('disabled');
  });
});

describe('previewCompareIdentifier', () => {
  test('uses a successfully sampled fallback when MediaLibrary did not return a newest id', () => {
    expect(previewCompareIdentifier({
      newestId: null,
      fallbackId: 'mapped-photo',
      sampledId: 'mapped-photo',
    })).toBe('mapped-photo');
  });

  test('does not enable fallback compare until that exact photo has a successful sample', () => {
    expect(previewCompareIdentifier({ newestId: null, fallbackId: 'mapped-photo', sampledId: null })).toBeNull();
    expect(previewCompareIdentifier({ newestId: null, fallbackId: 'mapped-photo', sampledId: 'old-photo' })).toBeNull();
  });

  test('keeps the MediaLibrary newest photo as the preferred compare target', () => {
    expect(previewCompareIdentifier({ newestId: 'newest', fallbackId: 'mapped-photo', sampledId: null })).toBe('newest');
  });
});

describe('previewSupportState', () => {
  test('distinguishes a retryable support request failure from confirmed unsupported', () => {
    expect(previewSupportState({ supported: null, loadFailed: true })).toBe('retry');
    expect(previewSupportState({ supported: false, loadFailed: false })).toBe('unsupported');
  });

  test('keeps initial support loading and a successful response distinct', () => {
    expect(previewSupportState({ supported: null, loadFailed: false })).toBe('loading');
    expect(previewSupportState({ supported: true, loadFailed: false })).toBe('ready');
  });
});

describe('previewStorageAddition', () => {
  test('is unavailable while scope is loading or failed, even when the partial plan says zero', () => {
    expect(previewStorageAddition({ scopeLoading: true, scopeFailed: false, toCreate: 0, avgBytes: 400 })).toBeNull();
    expect(previewStorageAddition({ scopeLoading: false, scopeFailed: true, toCreate: 0, avgBytes: 400 })).toBeNull();
  });

  test('shows zero only after a successful scope has established there is nothing to create', () => {
    expect(previewStorageAddition({ scopeLoading: false, scopeFailed: false, toCreate: 0, avgBytes: null })).toBe(0);
  });

  test('calculates known work and leaves an unknown estimate unavailable', () => {
    expect(previewStorageAddition({ scopeLoading: false, scopeFailed: false, toCreate: 3, avgBytes: 400 })).toBe(1200);
    expect(previewStorageAddition({ scopeLoading: false, scopeFailed: false, toCreate: 3, avgBytes: null })).toBeNull();
  });
});
