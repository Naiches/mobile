export class PreviewTimeoutError extends Error {
  readonly code = 'preview_timeout';

  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`${operation} took longer than ${timeoutMs} ms`);
    this.name = 'PreviewTimeoutError';
  }
}

/** Bound a user-facing wait. The underlying work may still settle safely later. */
export function withPreviewTimeout<T>(work: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new PreviewTimeoutError(operation, timeoutMs));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PreviewTimeoutError(operation, timeoutMs)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Bound a mutation and cancel it when the deadline expires. Unlike
 * `withPreviewTimeout`, callers provide the work as a factory so the same
 * signal can reach the network request before it starts.
 */
export function withAbortablePreviewTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new PreviewTimeoutError(operation, timeoutMs));
  }

  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => {
        controller.abort();
        reject(new PreviewTimeoutError(operation, timeoutMs));
      });
    }, timeoutMs);

    let pending: Promise<T>;
    try {
      pending = work(controller.signal);
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    Promise.resolve(pending).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
