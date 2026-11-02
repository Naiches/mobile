// @ts-nocheck
import { expect, test } from 'bun:test';
import {
  fetchWithDeadline,
  readResponseBlobWithDeadline,
  readResponseArrayBufferWithDeadline,
  readResponseJsonWithDeadline,
  RequestTimeoutError,
  settleWithDeadline,
} from './fetch-deadline';

test('a general promise that never settles rejects at its deadline', async () => {
  await expect(settleWithDeadline(
    () => new Promise<never>(() => {}),
    5,
  )).rejects.toBeInstanceOf(RequestTimeoutError);
});

test('a fetch that never settles is aborted and rejects at its deadline', async () => {
  let signal: AbortSignal | undefined;
  const fetcher = (_input: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  };

  const request = fetchWithDeadline(fetcher, 'https://api.test/files', undefined, 5);
  await expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
  expect(signal?.aborted).toBe(true);
});

test('a completed request is returned before the deadline', async () => {
  const response = new Response('{}', { status: 200 });
  await expect(fetchWithDeadline(async () => response, 'https://api.test/files', undefined, 100))
    .resolves.toBe(response);
});

test('response JSON parsing cannot remain pending after headers arrive', async () => {
  let cancelled = false;
  const response = {
    json: () => new Promise<never>(() => {}),
    body: { cancel: () => { cancelled = true; } },
  } as unknown as Response;

  await expect(readResponseJsonWithDeadline(response, 5)).rejects.toBeInstanceOf(RequestTimeoutError);
  expect(cancelled).toBe(true);
});

test('response blob parsing is bounded too', async () => {
  const response = {
    blob: () => new Promise<never>(() => {}),
    body: { cancel: () => Promise.resolve() },
  } as unknown as Response;

  await expect(readResponseBlobWithDeadline(response, 5)).rejects.toBeInstanceOf(RequestTimeoutError);
});

test('response array-buffer parsing is bounded too', async () => {
  const response = {
    arrayBuffer: () => new Promise<never>(() => {}),
    body: { cancel: () => Promise.resolve() },
  } as unknown as Response;

  await expect(readResponseArrayBufferWithDeadline(response, 5)).rejects.toBeInstanceOf(RequestTimeoutError);
});
