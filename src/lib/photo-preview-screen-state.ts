export type PreviewPrimaryAction = 'disabled' | 'none' | 'save' | 'apply';
export type PreviewSupportState = 'loading' | 'ready' | 'retry' | 'unsupported';

export function previewSupportState(input: {
  supported: boolean | null;
  loadFailed: boolean;
}): PreviewSupportState {
  if (input.loadFailed) return 'retry';
  if (input.supported === null) return 'loading';
  return input.supported ? 'ready' : 'unsupported';
}

export function previewCompareIdentifier(input: {
  newestId: string | null;
  fallbackId: string | null;
  sampledId: string | null;
}): string | null {
  if (input.newestId) return input.newestId;
  return input.fallbackId && input.sampledId === input.fallbackId ? input.fallbackId : null;
}

export function previewStorageAddition(input: {
  scopeLoading: boolean;
  scopeFailed: boolean;
  toCreate: number;
  avgBytes: number | null;
}): number | null {
  if (input.scopeLoading || input.scopeFailed) return null;
  if (input.toCreate <= 0) return 0;
  return input.avgBytes == null ? null : Math.round(input.avgBytes * input.toCreate);
}

export function previewPrimaryAction(input: {
  controlsReady: boolean;
  working: boolean;
  enabled: boolean;
  scopeReady: boolean;
  applyCount: number;
}): PreviewPrimaryAction {
  if (!input.controlsReady || input.working || !input.enabled) return 'disabled';
  if (input.applyCount > 0) return 'apply';
  return input.scopeReady ? 'none' : 'save';
}
