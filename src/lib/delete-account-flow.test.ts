// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { classifyDeletionRequestError, maskEmail, DELETION_LINK_TTL_LABEL } from './delete-account-flow';

class FakeApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

describe('maskEmail', () => {
  test('keeps the first character and the domain', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
  });
  test('a one-character local part still hides it', () => {
    expect(maskEmail('a@example.com')).toBe('*@example.com');
  });
  test('garbage never throws and never echoes a long string', () => {
    expect(maskEmail('')).toBe('your account email');
    expect(maskEmail('no-at-sign')).toBe('your account email');
  });
});

describe('classifyDeletionRequestError', () => {
  test('a missing route means the server needs an update', () => {
    expect(classifyDeletionRequestError(new FakeApiError(404, 'Not Found'), FakeApiError).kind).toBe('needs_update');
  });
  test('totp codes map to their own kinds', () => {
    expect(classifyDeletionRequestError(new FakeApiError(400, 'x', 'totp_code_required'), FakeApiError).kind).toBe('code_required');
    expect(classifyDeletionRequestError(new FakeApiError(400, 'x'), FakeApiError).kind).toBe('invalid_code');
  });
  test('a 409 deletion_needs_email_confirmation means the mail was sent', () => {
    expect(classifyDeletionRequestError(new FakeApiError(409, 'x', 'deletion_needs_email_confirmation'), FakeApiError).kind).toBe('email_sent');
  });
  test('anything else is other', () => {
    expect(classifyDeletionRequestError(new FakeApiError(502, 'x'), FakeApiError).kind).toBe('other');
    expect(classifyDeletionRequestError(new Error('boom'), FakeApiError).kind).toBe('other');
  });
  test('link lifetime label says one hour', () => {
    expect(DELETION_LINK_TTL_LABEL).toBe('1 hour');
  });
});
