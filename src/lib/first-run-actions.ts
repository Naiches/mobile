export interface FirstRunActionDependencies<TPermission = unknown, TAuth = { ok: boolean }> {
  authenticateDeviceOwner: () => Promise<TAuth>;
  writeLockSetting: (delayMs: number) => Promise<void>;
  ensurePhotoPermission: () => Promise<{ granted: boolean }>;
  readPhotoPermission: () => Promise<TPermission>;
  photoBackupEnabled: () => boolean;
  contactsBackupEnabled: () => boolean;
  calendarBackupEnabled: () => boolean;
  togglePhotoBackup: () => Promise<void>;
  toggleContactsBackup: () => Promise<void>;
  toggleCalendarBackup: () => Promise<void>;
  ensureContactsPermission: () => Promise<boolean>;
  ensureCalendarPermission: () => Promise<boolean>;
  ensureFilesMounted: () => Promise<unknown>;
  enableNotifications: () => Promise<boolean>;
}

export interface FirstRunActions<TPermission = unknown, TAuth = { ok: boolean }> {
  tryAppLock: () => Promise<TAuth>;
  setLockDelay: (delayMs: number) => Promise<void>;
  enablePhotoBackup: () => Promise<{ granted: boolean; permission: TPermission }>;
  setContactsBackup: (enabled: boolean) => Promise<boolean>;
  setCalendarBackup: (enabled: boolean) => Promise<boolean>;
  ensureFilesMounted: () => Promise<unknown>;
  enableNotifications: () => Promise<boolean>;
}

export function createFirstRunActions<TPermission = unknown, TAuth = { ok: boolean }>(
  deps: FirstRunActionDependencies<TPermission, TAuth>,
): FirstRunActions<TPermission, TAuth> {
  async function setBackup(
    desired: boolean,
    current: () => boolean,
    ensurePermission: () => Promise<boolean>,
    toggle: () => Promise<void>,
  ): Promise<boolean> {
    if (desired === current()) return true;
    if (desired && !(await ensurePermission())) return false;
    void toggle().catch(() => {});
    return true;
  }

  return {
    tryAppLock: deps.authenticateDeviceOwner,
    setLockDelay: deps.writeLockSetting,
    async enablePhotoBackup() {
      const outcome = await deps.ensurePhotoPermission();
      if (outcome.granted && !deps.photoBackupEnabled()) {
        void deps.togglePhotoBackup().catch(() => {});
      }
      return { granted: outcome.granted, permission: await deps.readPhotoPermission() };
    },
    setContactsBackup(enabled) {
      return setBackup(
        enabled,
        deps.contactsBackupEnabled,
        deps.ensureContactsPermission,
        deps.toggleContactsBackup,
      );
    },
    setCalendarBackup(enabled) {
      return setBackup(
        enabled,
        deps.calendarBackupEnabled,
        deps.ensureCalendarPermission,
        deps.toggleCalendarBackup,
      );
    },
    ensureFilesMounted: deps.ensureFilesMounted,
    enableNotifications: deps.enableNotifications,
  };
}
