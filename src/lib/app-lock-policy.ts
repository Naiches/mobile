// App lock policy: every lock decision in one pure module so App.tsx, the lock
// screen and Settings cannot drift apart.
//
// - The lock is ON unless the user explicitly turned it off ('false').
// - A signed-in cold launch always shows the lock screen, whatever the setting.
// - Returning to the app relocks only when the setting is ON and the app was in
//   the background for longer than the delay.
// - Turning protection down (lock off, longer delay) needs device authentication.

export const APP_LOCK_PREF_KEY = 'beebeeb_biometric_lock';
export const APP_LOCK_DELAY_KEY = 'beebeeb_biometric_delay';

/** Default "lock when returning after" delay: 15 minutes. */
export const DEFAULT_LOCK_DELAY_MS = 900_000;

export const APP_LOCK_DELAY_OPTIONS = [
  { label: 'Immediately', ms: 0 },
  { label: '1 minute', ms: 60_000 },
  { label: '5 minutes', ms: 300_000 },
  { label: '15 minutes', ms: DEFAULT_LOCK_DELAY_MS },
  { label: '1 hour', ms: 3_600_000 },
] as const;

export function lockDelayLabel(ms: number): string {
  return APP_LOCK_DELAY_OPTIONS.find((option) => option.ms === ms)?.label ?? 'Immediately';
}

/** Unset means ON. The Settings toggle is the only writer of 'false'. */
export function isAppLockEnabled(stored: string | null | undefined): boolean {
  return stored !== 'false';
}

/** A stored delay is kept (0 included); unset or unreadable falls back to the default. */
export function parseLockDelayMs(raw: string | null | undefined): number {
  if (raw == null || raw === '') return DEFAULT_LOCK_DELAY_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LOCK_DELAY_MS;
}

export function shouldLockAtLaunch(opts: { signedIn: boolean; recentlyUnlocked: boolean }): boolean {
  return opts.signedIn && !opts.recentlyUnlocked;
}

/**
 * `backgroundedForMs` is null unless the app really went to the background
 * (an `inactive` blip such as the Face ID or passcode sheet is not one).
 */
export function shouldRelockOnReturn(opts: {
  enabled: boolean;
  backgroundedForMs: number | null;
  delayMs: number;
  recentlyUnlocked: boolean;
}): boolean {
  if (!opts.enabled) return false;
  if (opts.backgroundedForMs == null) return false;
  if (opts.recentlyUnlocked) return false;
  return opts.backgroundedForMs > opts.delayMs;
}

export type LockSettingChange =
  | { kind: 'toggle'; enable: boolean }
  | { kind: 'delay'; fromMs: number; toMs: number };

export function settingChangeNeedsAuth(change: LockSettingChange): boolean {
  if (change.kind === 'toggle') return !change.enable;
  return change.toMs > change.fromMs;
}

export type SoftwareFallbackUnlockPlan = 'normal' | 'authenticate' | 'prefer-fallback';

/**
 * A software vault copy on physical hardware is not protected by the Secure
 * Enclave key's access control. Authenticate before reading it, then have the
 * authenticated retry read that copy directly so a stale/native copy cannot
 * raise a second Face ID sheet. A verified Beebeeb-password fallback remains
 * an intentional alternate unlock method.
 */
export function softwareFallbackUnlockPlan(opts: {
  physicalFallbackPresent: boolean;
  deviceOwnerAuthenticated: boolean;
  viaPassword: boolean;
}): SoftwareFallbackUnlockPlan {
  if (!opts.physicalFallbackPresent) return 'normal';
  return opts.deviceOwnerAuthenticated || opts.viaPassword
    ? 'prefer-fallback'
    : 'authenticate';
}

// Matches VAULT_NEEDS_PHRASE_MESSAGE (key-ownership.ts); duplicated so this
// module stays free of React Native imports.
const MISSING_KEY_PATTERN = /no master key in keychain/i;

export type KeyLoadOutcome = 'open' | 'stay-locked' | 'recovery';

/**
 * What a vault key load leads to. Only a missing key (fresh install / restore)
 * or a failed load after the Beebeeb password check goes to recovery; any other
 * failure keeps the lock screen up so the app never opens with a locked vault.
 */
export function classifyKeyLoad(opts: { error: unknown; viaPassword: boolean }): KeyLoadOutcome {
  if (opts.error == null) return 'open';
  const message = opts.error instanceof Error ? opts.error.message : '';
  if (MISSING_KEY_PATTERN.test(message)) return 'recovery';
  return opts.viaPassword ? 'recovery' : 'stay-locked';
}
