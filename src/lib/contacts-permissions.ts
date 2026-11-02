export interface ContactsPermissionResponse {
  status?: string;
  granted?: boolean;
}

export interface ContactsPermissionsModule {
  getPermissionsAsync?: () => Promise<ContactsPermissionResponse>;
  requestPermissionsAsync?: () => Promise<ContactsPermissionResponse>;
}

export function contactsPermissionGranted(
  permission: ContactsPermissionResponse | null | undefined,
): boolean {
  return permission?.granted === true || permission?.status === 'granted';
}

/** GET first so an existing grant never triggers another system prompt. */
export async function ensureContactsPermission(
  contactsModule: ContactsPermissionsModule,
): Promise<boolean> {
  const current = typeof contactsModule.getPermissionsAsync === 'function'
    ? await contactsModule.getPermissionsAsync()
    : null;
  if (contactsPermissionGranted(current)) return true;

  const requested = typeof contactsModule.requestPermissionsAsync === 'function'
    ? await contactsModule.requestPermissionsAsync()
    : null;
  return contactsPermissionGranted(requested);
}
