/**
 * Pure helpers for the delete-account screen: masking the address shown in
 * the "Check your email" state and mapping request errors to screen states.
 */

/** How long the emailed confirm link works (the server's token lifetime). */
export const DELETION_LINK_TTL_LABEL = '1 hour';

export const NEEDS_UPDATE_MESSAGE =
  'Account deletion needs an app or server update. Nothing was changed. Update Beebeeb, or delete your account from the web app.';

/** "alice@example.com" -> "a***@example.com". Never throws. */
export function maskEmail(email: string | null | undefined): string {
  const fallback = 'your account email';
  if (!email) return fallback;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return fallback;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return local.length === 1 ? `*@${domain}` : `${local[0]}***@${domain}`;
}

export type DeletionRequestFailure =
  | { kind: 'email_sent' }
  | { kind: 'needs_update' }
  | { kind: 'code_required' }
  | { kind: 'invalid_code' }
  | { kind: 'other' };

/**
 * Maps a failed request to a screen state. `ApiErrorClass` is passed in so
 * this file stays free of the api module's native imports.
 */
export function classifyDeletionRequestError(
  err: unknown,
  ApiErrorClass: new (...args: never[]) => Error & { status: number; code?: string },
): DeletionRequestFailure {
  if (err instanceof ApiErrorClass) {
    // The old endpoint's answer (mail sent, nothing deleted); the app never calls it, but it means the same.
    if (err.code === 'deletion_needs_email_confirmation') return { kind: 'email_sent' };
    if (err.status === 404 || err.status === 405) return { kind: 'needs_update' };
    if (err.code === 'totp_code_required') return { kind: 'code_required' };
    // A wrong code arrives as a plain 400 (the shared request helper keeps no
    // machine code for it); the request has no other way to answer 400.
    if (err.status === 400) return { kind: 'invalid_code' };
  }
  return { kind: 'other' };
}
