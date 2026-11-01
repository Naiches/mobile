// @ts-nocheck -- isolated upload harness; native/filesystem ports are explicit mocks.
import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';

type Progress = {
  phase: 'preparing' | 'uploading' | 'finalizing';
  chunksTotal: number;
  chunksUploaded: number;
  bytesTotal: number;
  bytesUploaded: number;
};

const statUris: string[] = [];
let statImpl: (uri: string) => Promise<{ exists: boolean; size?: number }> = async () => ({ exists: true, size: 10 });
let nativeImpl: (params: { fileId: string; onProgress?: (progress: Progress) => void }) => Promise<unknown> = async (params) => ({ id: params.fileId });
let chunkedImpl: (params: { fileId: string; onProgress?: (progress: Progress) => void }) => Promise<unknown> = async (params) => ({ id: params.fileId });
const settledFileIds: string[] = [];
const registeredSignals = new Map<string, AbortSignal>();

mock.module('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64' },
  getInfoAsync: async (uri: string) => {
    statUris.push(uri);
    return statImpl(uri);
  },
  readAsStringAsync: async () => '',
}));

mock.module('../../modules/beebeeb-crypto', () => ({
  generateRandomBytes: async (length: number) => new Uint8Array(length),
}));

mock.module('./account-epoch', () => ({
  accountEpoch: () => 1,
  isCurrentAccountEpoch: () => true,
}));
mock.module('./shared-folder-publish', () => ({ onOwnerUpload: () => {} }));
mock.module('./shared-folder-keys', () => ({ markOwnerUploadComplete: () => {} }));

mock.module('./api', () => ({
  uploadEncryptedFileNative: (params: unknown) => nativeImpl(params as never),
  uploadEncryptedChunked: (params: unknown) => chunkedImpl(params as never),
  clearUploadResumeState: async () => {},
  registerUploadAbort: (fileId: string, upstream?: AbortSignal) => {
    const controller = new AbortController();
    if (upstream?.aborted) controller.abort();
    else upstream?.addEventListener('abort', () => controller.abort(), { once: true });
    registeredSignals.set(fileId, controller.signal);
    return controller.signal;
  },
  settleUploadSignal: (fileId: string) => {
    settledFileIds.push(fileId);
    registeredSignals.delete(fileId);
  },
}));

const { createUploadGate } = await import('./upload-gate');
const uploadModule = await import('./encrypted-upload');
const {
  encryptedUpload,
  UploadPreparationTimeoutError,
  UPLOAD_STARTUP_INACTIVITY_TIMEOUT_MS,
} = uploadModule;

const progress = (phase: Progress['phase'], bytesUploaded = 0): Progress => ({
  phase,
  chunksTotal: 1,
  chunksUploaded: bytesUploaded > 0 ? 1 : 0,
  bytesTotal: 10,
  bytesUploaded,
});

const options = (fileId: string, uri = `file:///${fileId}`) => ({
  fileId,
  uri,
  name: `${fileId}.txt`,
  masterKeyHandleId: 7,
  encryptChunkFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16) }),
  encryptMetadataFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16) }),
});

async function flushMicrotasks(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
  statUris.length = 0;
  settledFileIds.length = 0;
  registeredSignals.clear();
  statImpl = async () => ({ exists: true, size: 10 });
  nativeImpl = async (params) => ({ id: params.fileId });
  chunkedImpl = async (params) => ({ id: params.fileId });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('encrypted upload startup deadline', () => {
  test('a filesystem stat that never settles fails visibly and releases the queued upload', async () => {
    statImpl = async (uri) => uri.endsWith('/stuck')
      ? new Promise(() => {})
      : { exists: true, size: 10 };
    const gate = createUploadGate();
    let queuedStarted = false;

    const first = gate.run(() => encryptedUpload(options('stuck')));
    const firstOutcome = first.catch((error) => error);
    const queued = gate.run(async () => {
      queuedStarted = true;
      return encryptedUpload(options('next'));
    });

    await flushMicrotasks();
    expect(statUris).toEqual(['file:///stuck']);
    expect(queuedStarted).toBe(false);

    jest.advanceTimersByTime(UPLOAD_STARTUP_INACTIVITY_TIMEOUT_MS);
    await flushMicrotasks();

    const error = await firstOutcome;
    expect(error).toBeInstanceOf(UploadPreparationTimeoutError);
    expect(error.message).toContain('selected file');
    await expect(queued).resolves.toMatchObject({ id: 'next' });
    expect(queuedStarted).toBe(true);
    expect(settledFileIds).toContain('stuck');
    expect(gate.isBusy()).toBe(false);
  });

  test('resume metadata that never settles cannot hold the shared gate forever', async () => {
    nativeImpl = async () => null;
    chunkedImpl = async (params) => params.fileId === 'stuck-resume'
      ? new Promise(() => {})
      : { id: params.fileId };
    const gate = createUploadGate();
    const first = gate.run(() => encryptedUpload(options('stuck-resume')));
    const firstOutcome = first.catch((error) => error);
    const queued = gate.run(() => encryptedUpload(options('after-resume')));

    await flushMicrotasks(40);
    expect(registeredSignals.get('stuck-resume')?.aborted).toBe(false);
    jest.advanceTimersByTime(UPLOAD_STARTUP_INACTIVITY_TIMEOUT_MS);
    await flushMicrotasks();

    expect(await firstOutcome).toBeInstanceOf(UploadPreparationTimeoutError);
    expect(registeredSignals.has('stuck-resume')).toBe(false);
    await expect(queued).resolves.toMatchObject({ id: 'after-resume' });
    expect(gate.isBusy()).toBe(false);
  });

  test('one preparing event does not let a hung native bridge startup escape the deadline', async () => {
    let startupSignal: AbortSignal | undefined;
    nativeImpl = async (params) => {
      startupSignal = registeredSignals.get(params.fileId);
      params.onProgress?.(progress('preparing'));
      return new Promise(() => {});
    };
    const upload = encryptedUpload(options('stuck-bridge'));
    const outcome = upload.catch((error) => error);

    await flushMicrotasks();
    jest.advanceTimersByTime(UPLOAD_STARTUP_INACTIVITY_TIMEOUT_MS);
    await flushMicrotasks();

    expect(await outcome).toBeInstanceOf(UploadPreparationTimeoutError);
    expect(startupSignal?.aborted).toBe(true);
    expect(settledFileIds).toContain('stuck-bridge');
  });

  test('real bridge progress disarms the startup timer instead of timing the whole transfer', async () => {
    let finish!: (entry: { id: string }) => void;
    nativeImpl = async (params) => {
      params.onProgress?.(progress('preparing'));
      params.onProgress?.(progress('uploading', 1));
      return new Promise((resolve) => { finish = resolve; });
    };
    let settled = false;
    const upload = encryptedUpload(options('large-transfer')).finally(() => { settled = true; });

    await flushMicrotasks();
    jest.advanceTimersByTime(UPLOAD_STARTUP_INACTIVITY_TIMEOUT_MS * 3);
    await flushMicrotasks();
    expect(settled).toBe(false);

    finish({ id: 'large-transfer' });
    await expect(upload).resolves.toMatchObject({ id: 'large-transfer' });
  });
});
