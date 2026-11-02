export const DEFAULT_SCREEN_REQUEST_TIMEOUT_MS = 15_000;
export const UPLOAD_CONTROL_REQUEST_TIMEOUT_MS = 30_000;
/** Transfer bodies may be large, but still must eventually release their UI/gate. */
export const TRANSFER_REQUEST_TIMEOUT_MS = 6 * 60_000;

export class RequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.name = 'RequestTimeoutError';
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Bound any async preparation/consumption step, including work before fetch. */
export async function settleWithDeadline<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(new RequestTimeoutError(timeoutMs));
      }
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // React Native response bodies do not always expose a cancellable stream.
  }
}

/** Keep a bounded request bounded while its response body is being consumed. */
export function readResponseJsonWithDeadline<T = unknown>(
  response: Response,
  timeoutMs: number = DEFAULT_SCREEN_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return settleWithDeadline(
    () => response.json() as Promise<T>,
    timeoutMs,
    () => cancelResponseBody(response),
  );
}

/** Blob responses need the same body deadline as JSON responses. */
export function readResponseBlobWithDeadline(
  response: Response,
  timeoutMs: number = DEFAULT_SCREEN_REQUEST_TIMEOUT_MS,
): Promise<Blob> {
  return settleWithDeadline(
    () => response.blob(),
    timeoutMs,
    () => cancelResponseBody(response),
  );
}

/** Array-buffer consumers otherwise escape the response-body deadline. */
export function readResponseArrayBufferWithDeadline(
  response: Response,
  timeoutMs: number = DEFAULT_SCREEN_REQUEST_TIMEOUT_MS,
): Promise<ArrayBuffer> {
  return settleWithDeadline(
    () => response.arrayBuffer(),
    timeoutMs,
    () => cancelResponseBody(response),
  );
}

/** Bound a fetch even if its implementation fails to reject promptly after abort. */
export async function fetchWithDeadline(
  fetcher: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number = DEFAULT_SCREEN_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const upstream = init?.signal;
  const relayAbort = () => controller.abort();
  if (upstream?.aborted) relayAbort();
  else upstream?.addEventListener('abort', relayAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetcher(input, { ...init, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    upstream?.removeEventListener('abort', relayAbort);
  }
}
