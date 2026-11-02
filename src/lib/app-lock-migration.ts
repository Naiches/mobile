// One-time move of the vault key from Face-ID-only or the old passcode-only
// policy to user presence, so Face ID is tried first with passcode fallback.
// Runs after a successful unlock; a failure is harmless and retried next time.

export const PASSCODE_MIGRATION_KEY = 'beebeeb_lock_user_presence_migrated_v1';

/**
 * A native vault load proves Face ID consent only after the stored key is
 * already on the Face-first user-presence policy. The first upgraded load of
 * an old `.devicePasscode` key shows a strict passcode sheet and migrates the
 * key afterwards; treating that sheet as Face ID would make the wizard claim
 * Face ID is on before Beebeeb has ever asked for it.
 */
export function nativeVaultAuthConfirmsFace(opts: {
  accessControlAlreadyCurrent: boolean;
  explicitAuthRequired: boolean;
  vaultOpened: boolean;
  viaPassword?: boolean;
  viaSoftwareFallback?: boolean;
}): boolean {
  return opts.accessControlAlreadyCurrent
    && !opts.explicitAuthRequired
    && opts.vaultOpened
    && !opts.viaPassword
    && !opts.viaSoftwareFallback;
}

interface PasscodeKeyMigrationDeps {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  setBiometricRequirement: (require: boolean) => Promise<void>;
}

let migrationInFlight: Promise<void> | null = null;

async function performPasscodeKeyMigration(deps: PasscodeKeyMigrationDeps): Promise<void> {
  try {
    if ((await deps.get(PASSCODE_MIGRATION_KEY)) === '1') return;
    await deps.setBiometricRequirement(false);
    await deps.set(PASSCODE_MIGRATION_KEY, '1');
  } catch {
    // Retried on the next unlock; never blocks or fails an unlock.
  }
}

export function runPasscodeKeyMigration(deps: PasscodeKeyMigrationDeps): Promise<void> {
  if (migrationInFlight) return migrationInFlight;
  const tracked = performPasscodeKeyMigration(deps).finally(() => {
    if (migrationInFlight === tracked) migrationInFlight = null;
  });
  migrationInFlight = tracked;
  return tracked;
}
