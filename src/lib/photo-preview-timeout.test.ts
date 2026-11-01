// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  PreviewTimeoutError,
  withAbortablePreviewTimeout,
  withPreviewTimeout,
} from './photo-preview-timeout';

describe('withPreviewTimeout', () => {
  test('returns work that settles before the deadline', async () => {
    await expect(withPreviewTimeout(Promise.resolve('ok'), 50, 'sample')).resolves.toBe('ok');
  });

  test('rejects a stalled operation with a typed error', async () => {
    const never = new Promise<never>(() => {});
    const error = await withPreviewTimeout(never, 1, 'photo sample').catch((e) => e);
    expect(error).toBeInstanceOf(PreviewTimeoutError);
    expect(error.message).toContain('photo sample');
  });

  test('aborts a timed-out mutation so it cannot land after a newer mutation', async () => {
    const committed: string[] = [];
    let timedOutSignal: AbortSignal | null = null;

    const stale = withAbortablePreviewTimeout((signal) => {
      timedOutSignal = signal;
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!signal.aborted) committed.push('stale off');
          resolve();
        }, 25);
      });
    }, 1, 'stale toggle');

    await expect(stale).rejects.toBeInstanceOf(PreviewTimeoutError);
    expect(timedOutSignal?.aborted).toBe(true);

    await withAbortablePreviewTimeout(async (signal) => {
      expect(signal.aborted).toBe(false);
      committed.push('new on');
    }, 50, 'new toggle');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(committed).toEqual(['new on']);
  });
});
