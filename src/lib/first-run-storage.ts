import * as SecureStore from 'expo-secure-store';
import type { FirstRunStorage } from './first-run-setup';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** Setup state belongs to this physical device and must not migrate in a backup. */
export const firstRunSecureStorage: FirstRunStorage = {
  getItemAsync: (key) => SecureStore.getItemAsync(key, OPTIONS),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
};
