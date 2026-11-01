import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Calendar from 'expo-calendar';
import * as Contacts from 'expo-contacts';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import type { RootStackParamList } from '../App';
import { NativeSwitch } from '../components/NativeSwitch';
import { useAuth } from '../lib/auth';
import { useBackup } from '../lib/backup-context';
import { ensureCalendarPermission } from '../lib/calendar-permissions';
import { ensureContactsPermission } from '../lib/contacts-permissions';
import {
  getDeviceOwnerAuthState,
  requestDeviceOwnerAuth,
  type DeviceOwnerAuthResult,
} from '../lib/device-owner-auth';
import type { DeviceOwnerAuthState } from '../lib/device-owner-auth-policy';
import { ensureFilesMountedByDefault } from '../lib/files-mount-default';
import { createFirstRunActions } from '../lib/first-run-actions';
import { useFirstRunSetup } from '../lib/first-run-context';
import {
  FIRST_RUN_ITEM_CATEGORIES,
  firstRunPosition,
  firstRunSummaryItemLinksToSettings,
  photoPermissionNeedsSettings,
  type FirstRunItem,
} from '../lib/first-run-setup';
import {
  APP_LOCK_DELAY_KEY,
  APP_LOCK_DELAY_OPTIONS,
  APP_LOCK_PREF_KEY,
  DEFAULT_LOCK_DELAY_MS,
  isAppLockEnabled,
  lockDelayLabel,
  parseLockDelayMs,
  settingChangeNeedsAuth,
} from '../lib/app-lock-policy';
import { useCoachMarks } from '../lib/coach-marks-context';
import { getPhotoPermission, type PhotoPermissionResponse, ensurePhotoPermission } from '../lib/photo-permissions';
import { enablePushNotifications, NOTIFICATIONS_OPT_OUT_KEY } from '../lib/push-notifications';
import { useTheme } from '../lib/theme-context';
import { fonts, onAmber, radii, spacing } from '../theme';

type Navigation = NativeStackNavigationProp<RootStackParamList, 'FirstRunSetup'>;
type IconName = React.ComponentProps<typeof Ionicons>['name'];
function lockCopy(
  state: DeviceOwnerAuthState | null,
  enabled: boolean,
): { name: string; button: string; sentence: string; icon: IconName; openSettings: boolean } {
  const biometric = state?.biometric ?? 'none';
  const indeterminate = state?.kind === 'indeterminate';
  const name = indeterminate ? 'Face ID' : biometric === 'face' ? 'Face ID' : biometric === 'fingerprint' ? 'Touch ID' : 'iPhone passcode';
  const icon: IconName = indeterminate || biometric === 'face' ? 'scan-outline' : biometric === 'fingerprint' ? 'finger-print-outline' : 'keypad-outline';
  const openSettings = state?.openSettings === true;
  const setting = enabled ? 'App lock is on.' : 'App lock is off.';
  return {
    name,
    button: openSettings ? 'Open iOS Settings' : indeterminate ? 'Try Face ID' : `Try ${name}`,
    sentence: `${setting} ${state?.message ?? `Beebeeb uses ${name} or your iPhone passcode when it locks.`}`,
    icon,
    openSettings,
  };
}

export default function FirstRunSetupScreen() {
  const navigation = useNavigation<Navigation>();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const accessibilityLayout = fontScale >= 1.3;
  const { colors: c } = useTheme();
  const { user } = useAuth();
  const setup = useFirstRunSetup();
  const coachMarks = useCoachMarks();
  const backup = useBackup();
  const filesCheckedRef = useRef(false);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authState, setAuthState] = useState<DeviceOwnerAuthState | null>(null);
  const [lockStateReady, setLockStateReady] = useState(false);
  const [appLockEnabled, setAppLockEnabled] = useState(true);
  const [lockDelay, setLockDelay] = useState(DEFAULT_LOCK_DELAY_MS);
  const [lockTryResult, setLockTryResult] = useState<'idle' | 'success' | 'failed'>('idle');
  const [photoPermission, setPhotoPermission] = useState<PhotoPermissionResponse | null>(null);
  const [photoVisibleCount, setPhotoVisibleCount] = useState(0);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);

  const screen = setup.state.screen;
  const progress = firstRunPosition(screen);
  const lock = lockCopy(authState, appLockEnabled);

  useEffect(() => {
    let live = true;
    void Promise.all([
      getDeviceOwnerAuthState(),
      SecureStore.getItemAsync(APP_LOCK_DELAY_KEY).catch(() => null),
      SecureStore.getItemAsync(APP_LOCK_PREF_KEY).catch(() => null),
    ]).then(([nextAuthState, storedDelay, storedLockPreference]) => {
      if (!live) return;
      setAuthState(nextAuthState);
      setAppLockEnabled(isAppLockEnabled(storedLockPreference));
      setLockDelay(parseLockDelayMs(storedDelay));
    }).finally(() => {
      if (live) setLockStateReady(true);
    });
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      void getDeviceOwnerAuthState().then((nextAuthState) => {
        if (live) setAuthState(nextAuthState);
      });
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  const refreshPhotoAccess = useCallback(async (known?: PhotoPermissionResponse | null) => {
    const permission = known === undefined ? await getPhotoPermission(MediaLibrary).catch(() => null) : known;
    setPhotoPermission(permission);
    if (permission?.status === 'granted' && permission.accessPrivileges === 'limited') {
      try {
        const page = await MediaLibrary.getAssetsAsync({
          first: 1,
          mediaType: MediaLibrary.MediaType.photo,
        });
        setPhotoVisibleCount(page.totalCount);
      } catch {
        setPhotoVisibleCount(0);
      }
    } else {
      setPhotoVisibleCount(0);
    }
    return permission;
  }, []);

  useEffect(() => {
    if (screen !== 'photo-backup') return;
    void refreshPhotoAccess();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refreshPhotoAccess();
    });
    return () => { subscription.remove(); };
  }, [refreshPhotoAccess, screen]);

  useEffect(() => {
    if (screen !== 'files-notifications') return;
    void (async () => {
      try {
        const [{ status }, optedOut] = await Promise.all([
          Notifications.getPermissionsAsync(),
          SecureStore.getItemAsync(NOTIFICATIONS_OPT_OUT_KEY),
        ]);
        setNotificationsEnabled(status === 'granted' && optedOut !== 'true');
      } catch {
        setNotificationsEnabled(false);
      }
    })();
  }, [screen]);

  const actions = useMemo(() => createFirstRunActions<PhotoPermissionResponse | null, DeviceOwnerAuthResult>({
    authenticateDeviceOwner: () => requestDeviceOwnerAuth(`Try ${lock.name}`, {
      cancelled: `${lock.name} was cancelled. You can continue or try again.`,
      failed: `${lock.name} did not match. You can continue or try again.`,
      unavailable: 'Device authentication is not available. You can continue.',
    }),
    writeLockSetting: async (delayMs) => {
      if (settingChangeNeedsAuth({ kind: 'delay', fromMs: lockDelay, toMs: delayMs })) {
        const auth = await requestDeviceOwnerAuth('Confirm it is you to change when Beebeeb locks', {
          cancelled: 'The lock delay is unchanged.',
          failed: 'The lock delay is unchanged.',
          unavailable: 'The lock delay is unchanged.',
        });
        if (!auth.ok) throw new Error(auth.message);
      }
      await SecureStore.setItemAsync(APP_LOCK_DELAY_KEY, String(delayMs));
    },
    ensurePhotoPermission: () => ensurePhotoPermission(MediaLibrary),
    readPhotoPermission: () => getPhotoPermission(MediaLibrary),
    photoBackupEnabled: () => backup.isPhotoBackupEnabled,
    contactsBackupEnabled: () => backup.isContactsBackupEnabled,
    calendarBackupEnabled: () => backup.isCalendarBackupEnabled,
    togglePhotoBackup: backup.togglePhotoBackup,
    toggleContactsBackup: backup.toggleContactsBackup,
    toggleCalendarBackup: backup.toggleCalendarBackup,
    ensureContactsPermission: () => ensureContactsPermission(Contacts),
    ensureCalendarPermission: () => ensureCalendarPermission(Calendar),
    ensureFilesMounted: () => ensureFilesMountedByDefault(user?.user_id),
    enableNotifications: () => enablePushNotifications(),
  }), [
    backup.isCalendarBackupEnabled,
    backup.isContactsBackupEnabled,
    backup.isPhotoBackupEnabled,
    backup.toggleCalendarBackup,
    backup.toggleContactsBackup,
    backup.togglePhotoBackup,
    lock.name,
    lockDelay,
    user?.user_id,
  ]);

  useEffect(() => {
    if (screen !== 'files-notifications' || filesCheckedRef.current) return;
    filesCheckedRef.current = true;
    void actions.ensureFilesMounted();
  }, [actions, screen]);

  const run = useCallback(async (task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong. Try again.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const skipStep = () => run(setup.skip);

  const continuePhoto = () => run(async () => {
    await setup.markDone('photo-backup');
    await setup.advance();
  });

  const continueNotifications = () => run(async () => {
    await setup.markDone('notifications');
    await setup.advance();
  });

  const tryLock = () => run(async () => {
    if (lock.openSettings) {
      await Linking.openSettings();
      return;
    }
    const result = await actions.tryAppLock();
    setAuthState(result.authState);
    setLockTryResult(result.ok ? 'success' : 'failed');
    if (result.ok) {
      await SecureStore.setItemAsync(APP_LOCK_PREF_KEY, 'true');
      setAppLockEnabled(true);
      await setup.markDone('app-lock');
      setError(null);
    } else {
      setError(result.message);
    }
  });

  const chooseLockDelay = (delayMs: number) => run(async () => {
    await actions.setLockDelay(delayMs);
    setLockDelay(delayMs);
  });

  const continueLock = () => run(async () => {
    if (appLockEnabled) await setup.markDone('app-lock');
    else await setup.markRemaining(['app-lock']);
    await setup.advance();
  });

  const enablePhotos = () => run(async () => {
    const outcome = await actions.enablePhotoBackup();
    await refreshPhotoAccess(outcome.permission);
    if (!outcome.granted) {
      await setup.markRemaining(['photo-backup']);
      return;
    }
    await setup.markDone('photo-backup');
    if (outcome.permission?.accessPrivileges !== 'limited') await setup.advance();
  });

  const choosePhotos = () => run(async () => {
    await MediaLibrary.presentPermissionsPickerAsync?.();
    await refreshPhotoAccess();
  });

  const setContacts = (enabled: boolean) => run(async () => {
    const changed = await actions.setContactsBackup(enabled);
    if (!changed) {
      setError('Contacts access was not allowed. You can continue and change it later.');
      await setup.markRemaining(['contacts']);
      return;
    }
    if (enabled) await setup.markDone('contacts');
    else await setup.markRemaining(['contacts']);
  });

  const setCalendar = (enabled: boolean) => run(async () => {
    const changed = await actions.setCalendarBackup(enabled);
    if (!changed) {
      setError('Calendar access was not allowed. You can continue and change it later.');
      await setup.markRemaining(['calendar']);
      return;
    }
    if (enabled) await setup.markDone('calendar');
    else await setup.markRemaining(['calendar']);
  });

  const continueContacts = () => run(async () => {
    if (backup.isContactsBackupEnabled) await setup.markDone('contacts');
    else await setup.markRemaining(['contacts']);
    if (backup.isCalendarBackupEnabled) await setup.markDone('calendar');
    else await setup.markRemaining(['calendar']);
    await setup.advance();
  });

  const allowNotifications = () => run(async () => {
    const enabled = await actions.enableNotifications();
    setNotificationsEnabled(enabled);
    if (enabled) {
      await setup.markDone('notifications');
      await setup.advance();
    } else {
      await setup.markRemaining(['notifications']);
      setError('Notifications were not allowed. You can turn them on later in iOS Settings.');
    }
  });

  const finish = (destination: 'files' | 'settings') => run(async () => {
    if (backup.isPhotoBackupEnabled) await setup.markDone('photo-backup');
    if (backup.isContactsBackupEnabled) await setup.markDone('contacts');
    if (backup.isCalendarBackupEnabled) await setup.markDone('calendar');
    if (notificationsEnabled) await setup.markDone('notifications');
    await coachMarks.start();
    await setup.complete();
    navigation.replace('Tabs', destination === 'settings' ? { screen: 'Settings' } : { screen: 'Files' });
  });

  const openSkippedSetting = (item: FirstRunItem) => run(async () => {
    if (item === 'app-lock') await setup.markDone(item);
    await coachMarks.start();
    await setup.complete();
    navigation.replace('Tabs', {
      screen: 'Settings',
      params: { firstRunCategory: FIRST_RUN_ITEM_CATEGORIES[item] },
    });
  });

  const renderAppLock = () => {
    if (!lockStateReady) {
      return (
        <StepBody footer={<View />} insetsBottom={insets.bottom}>
          <View style={styles.loadingState} testID="first-run-lock-loading">
            <ActivityIndicator color={c.ink3} />
            <Text style={[styles.subtitle, { color: c.ink3 }]}>Checking app lock on this iPhone…</Text>
          </View>
        </StepBody>
      );
    }
    return (
      <StepBody footer={(
      <>
        <PrimaryButton label={lockTryResult === 'failed' && !lock.openSettings ? 'Try again' : lock.button} onPress={tryLock} colors={c} busy={busy} testID={lock.openSettings ? 'first-run-lock-settings' : 'first-run-try-lock'} />
        <LinkButton label="Continue" onPress={continueLock} color={c.amberDeep} testID="first-run-lock-continue" />
      </>
    )} insetsBottom={insets.bottom}>
      <Illustration icon={lock.icon} colors={c} compact />
      <Text style={[styles.title, { color: c.ink }]}>Lock Beebeeb</Text>
      <Text style={[styles.subtitle, { color: c.ink3 }]}>{lock.sentence}</Text>
      <Text style={[styles.sectionLabel, { color: c.ink4 }]}>Lock again after</Text>
      <View style={styles.chips}>
        {APP_LOCK_DELAY_OPTIONS.map((option) => {
          const selected = option.ms === lockDelay;
          return (
            <TouchableOpacity
              key={option.ms}
              onPress={() => chooseLockDelay(option.ms)}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              style={[styles.chip, { borderColor: selected ? c.amber : c.line, backgroundColor: selected ? c.amber : c.paper }]}
            >
              <Text style={{ color: selected ? onAmber : c.ink2, fontSize: 13, fontWeight: selected ? '700' : '400' }}>{option.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {lockTryResult === 'success' ? <Notice text="App lock worked. Continue when you are ready." colors={c} /> : null}
      </StepBody>
    );
  };

  const photoDenied = photoPermissionNeedsSettings(photoPermission);
  const photoLimited = photoPermission?.status === 'granted' && photoPermission.accessPrivileges === 'limited';
  const renderPhoto = () => {
    if (photoDenied) {
      return (
        <StepBody footer={(
          <>
            <PrimaryButton label="Open iOS Settings" onPress={() => { void Linking.openSettings(); }} colors={c} testID="first-run-photo-settings" />
            <LinkButton label="Not now" onPress={skipStep} color={c.amberDeep} />
          </>
        )} insetsBottom={insets.bottom}>
          <Illustration icon="images-outline" colors={c} compact important />
          <Text style={[styles.title, { color: c.ink }]}>Photo access is off</Text>
          <Text style={[styles.subtitle, { color: c.ink3 }]}>Allow Photos access in iOS Settings, then come back to turn on encrypted backup.</Text>
        </StepBody>
      );
    }
    if (photoLimited && backup.isPhotoBackupEnabled) {
      return (
        <StepBody footer={(
          <>
            <PrimaryButton label="Choose photos" onPress={choosePhotos} colors={c} busy={busy} testID="first-run-choose-photos" />
            <SecondaryButton label="Continue" onPress={continuePhoto} colors={c} />
          </>
        )} insetsBottom={insets.bottom}>
          <View style={[styles.importantCard, { backgroundColor: c.paper2, borderColor: c.amber }]}>
            <Text style={[styles.title, { color: c.ink, marginTop: 0 }]}>Photo backup is on</Text>
            <Text style={[styles.subtitle, { color: c.ink3, marginBottom: 0 }]}>
              Only {photoVisibleCount.toLocaleString()} photo{photoVisibleCount === 1 ? ' is' : 's are'} shared with Beebeeb right now.
            </Text>
          </View>
          <Notice text="You chose Selected Photos. Only those are backed up. Pick more or allow all photos." colors={c} />
        </StepBody>
      );
    }
    return (
      <StepBody footer={(
        <>
          <PrimaryButton
            label={backup.isPhotoBackupEnabled ? 'Continue' : 'Turn on photo backup'}
            onPress={backup.isPhotoBackupEnabled ? continuePhoto : enablePhotos}
            colors={c}
            busy={busy}
            testID="first-run-enable-photos"
          />
          <LinkButton label="Not now" onPress={skipStep} color={c.amberDeep} />
        </>
      )} insetsBottom={insets.bottom}>
        <View style={[styles.importantCard, { backgroundColor: c.paper2, borderColor: c.amber }]}>
          <View style={[styles.smallIcon, { backgroundColor: c.amberBg, borderColor: c.line }]}>
            <Ionicons name="images-outline" size={28} color={c.amberDeep} />
          </View>
          <Text style={[styles.title, { color: c.ink }]}>Back up your photos</Text>
          <Text style={[styles.subtitle, { color: c.ink3, marginBottom: 0 }]}>New photos and videos are encrypted on this phone, then uploaded. We cannot see them.</Text>
        </View>
        <Text style={[styles.sectionLabel, { color: c.ink4 }]}>iOS will ask which photos</Text>
        <InfoRow title="All Photos" body="Backs up everything, including new shots. Recommended." icon="checkmark-circle-outline" colors={c} />
        <InfoRow title="Selected Photos" body="Only the ones you pick. You can add more later in Beebeeb." icon="albums-outline" colors={c} />
      </StepBody>
    );
  };

  const renderContacts = () => (
    <StepBody footer={(
      <>
        <PrimaryButton label="Continue" onPress={continueContacts} colors={c} busy={busy} testID="first-run-contacts-continue" />
        <LinkButton label="Skip" onPress={skipStep} color={c.amberDeep} />
      </>
    )} insetsBottom={insets.bottom}>
      <Text style={[styles.title, { color: c.ink }]}>Contacts and calendar</Text>
      <Text style={[styles.subtitle, { color: c.ink3 }]}>Encrypted copies you can restore on a new phone. iOS asks when you turn one on.</Text>
      <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
        <ToggleRow
          title="Contacts"
          body="Back up your address book."
          icon="people-outline"
          value={backup.isContactsBackupEnabled}
          onChange={setContacts}
          disabled={busy}
          colors={c}
          testID="first-run-contacts-toggle"
        />
        <View style={[styles.divider, { backgroundColor: c.line }]} />
        <ToggleRow
          title="Calendar"
          body="Back up your events."
          icon="calendar-outline"
          value={backup.isCalendarBackupEnabled}
          onChange={setCalendar}
          disabled={busy}
          colors={c}
          testID="first-run-calendar-toggle"
        />
      </View>
    </StepBody>
  );

  const renderFilesNotifications = () => (
    <StepBody footer={(
      <>
        <PrimaryButton
          label={notificationsEnabled ? 'Continue' : 'Allow notifications'}
          onPress={notificationsEnabled ? continueNotifications : allowNotifications}
          colors={c}
          busy={busy}
          testID="first-run-allow-notifications"
        />
        {!notificationsEnabled ? <LinkButton label="Not now" onPress={skipStep} color={c.amberDeep} /> : null}
      </>
    )} insetsBottom={insets.bottom}>
      <Text style={[styles.title, { color: c.ink }]}>Files app and alerts</Text>
      <View style={[styles.filesIllustration, { backgroundColor: c.paper2, borderColor: c.line }]}> 
        <View style={[styles.filesPanel, { backgroundColor: c.paper, borderColor: c.line }]}>
          <Text style={[styles.filesRow, { color: c.ink3, borderBottomColor: c.line }]}>Browse</Text>
          <Text style={[styles.filesRow, { color: c.ink3, borderBottomColor: c.line }]}>iCloud Drive</Text>
          <View style={[styles.filesHighlight, { backgroundColor: c.amberBg }]}>
            <Ionicons name="folder-open-outline" size={18} color={c.amberDeep} />
            <Text style={{ color: c.ink, fontWeight: '700' }}>Beebeeb</Text>
          </View>
          <Text style={[styles.filesRow, { color: c.ink3 }]}>On My iPhone</Text>
        </View>
      </View>
      <Text style={[styles.subtitle, { color: c.ink3 }]}>Your files show in the Files app under Browse, then Beebeeb.</Text>
      <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line, padding: spacing.md }]}>
        <Text style={[styles.rowTitle, { color: c.ink }]}>Notifications</Text>
        <Text style={[styles.rowBody, { color: c.ink3 }]}>Get told when a backup finishes or someone signs in to your account.</Text>
      </View>
    </StepBody>
  );

  const doneRowSettings: Array<{ item: FirstRunItem; title: string; value: string; enabled: boolean }> = [
    {
      item: 'app-lock',
      title: 'App lock',
      value: appLockEnabled ? `On · ${lockDelayLabel(lockDelay)}` : 'Off',
      enabled: appLockEnabled,
    },
    { item: 'photo-backup', title: 'Photo backup', value: backup.isPhotoBackupEnabled ? 'On' : 'Off', enabled: backup.isPhotoBackupEnabled },
    { item: 'contacts', title: 'Contacts', value: backup.isContactsBackupEnabled ? 'On' : 'Off', enabled: backup.isContactsBackupEnabled },
    { item: 'calendar', title: 'Calendar', value: backup.isCalendarBackupEnabled ? 'On' : 'Off', enabled: backup.isCalendarBackupEnabled },
    { item: 'notifications', title: 'Notifications', value: notificationsEnabled ? 'On' : 'Off', enabled: notificationsEnabled },
  ];
  const doneRows = doneRowSettings.map((row) => ({
    ...row,
    link: firstRunSummaryItemLinksToSettings(setup.state, row.item, row.enabled),
  }));

  const renderDone = () => (
    <StepBody footer={(
      <>
        <PrimaryButton label="Open Beebeeb" onPress={() => finish('files')} colors={c} busy={busy} testID="first-run-done" />
        <LinkButton label="More in Settings" onPress={() => finish('settings')} color={c.amberDeep} />
      </>
    )} insetsBottom={insets.bottom}>
      <Illustration icon="checkmark" colors={c} compact success />
      <Text style={[styles.title, { color: c.ink }]}>You are set up</Text>
      <View style={[styles.card, { backgroundColor: c.paper2, borderColor: c.line }]}>
        {doneRows.map((row, index) => (
          <React.Fragment key={row.item}>
            {index > 0 ? <View style={[styles.divider, { backgroundColor: c.line }]} /> : null}
            <TouchableOpacity
              style={[styles.doneRow, accessibilityLayout && { alignItems: 'flex-start', flexWrap: 'wrap' }]}
              onPress={row.link ? () => openSkippedSetting(row.item) : undefined}
              disabled={!row.link || busy}
              accessibilityRole={row.link ? 'link' : undefined}
              accessibilityHint={row.link ? `Open ${row.title} settings` : undefined}
            >
              <Ionicons name={row.enabled ? 'checkmark-circle' : 'remove-circle-outline'} size={20} color={row.enabled ? c.green : c.ink4} />
              <Text style={[styles.rowTitle, { color: c.ink, flex: 1 }]}>{row.title}</Text>
              <Text style={[styles.rowBody, { color: row.link ? c.amberDeep : c.ink3 }]}>{row.value}</Text>
              {row.link ? <Ionicons name="chevron-forward" size={14} color={c.amberDeep} /> : null}
            </TouchableOpacity>
          </React.Fragment>
        ))}
      </View>
    </StepBody>
  );

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]} testID="first-run-setup-screen">
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Text style={[styles.progress, { color: c.ink4 }]}>{progress ? `${progress.position} of ${progress.total}` : ''}</Text>
        {screen !== 'done' ? (
          <TouchableOpacity
            onPress={skipStep}
            accessibilityRole="button"
            accessibilityLabel="Skip this setup step"
            testID="first-run-skip"
          >
            <Text style={[styles.skip, { color: c.amberDeep }]}>Skip</Text>
          </TouchableOpacity>
        ) : <View />}
      </View>
      {error ? (
        <View style={[styles.error, { backgroundColor: c.paper2, borderColor: c.red }]} accessibilityRole="alert">
          <Text style={[styles.errorText, { color: c.red }]}>{error}</Text>
        </View>
      ) : null}
      {screen === 'app-lock' ? renderAppLock() : null}
      {screen === 'photo-backup' ? renderPhoto() : null}
      {screen === 'contacts-calendar' ? renderContacts() : null}
      {screen === 'files-notifications' ? renderFilesNotifications() : null}
      {screen === 'done' ? renderDone() : null}
    </View>
  );
}

function StepBody({
  children,
  footer,
  insetsBottom,
}: {
  children: React.ReactNode;
  footer: React.ReactNode;
  insetsBottom: number;
}) {
  return (
    <>
      <ScrollView
        style={styles.stepScroll}
        contentContainerStyle={styles.stepContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: insetsBottom + spacing.md }]}>{footer}</View>
    </>
  );
}

function Illustration({
  icon,
  colors: c,
  compact,
  important,
  success,
}: {
  icon: IconName;
  colors: ReturnType<typeof useTheme>['colors'];
  compact?: boolean;
  important?: boolean;
  success?: boolean;
}) {
  return (
    <View style={[
      styles.illustration,
      compact && styles.illustrationCompact,
      { backgroundColor: c.paper2, borderColor: important ? c.amber : c.line },
    ]}>
      <View style={[
        styles.illustrationIcon,
        { backgroundColor: success ? c.green : c.amberBg, borderColor: success ? c.green : c.line },
      ]}>
        <Ionicons name={icon} size={34} color={success ? c.white : c.amberDeep} />
      </View>
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  colors: c,
  busy,
  testID,
}: {
  label: string;
  onPress: () => void;
  colors: ReturnType<typeof useTheme>['colors'];
  busy?: boolean;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.button, { backgroundColor: c.amber }, busy && styles.disabled]}
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: !!busy, disabled: !!busy }}
      testID={testID}
    >
      {busy ? <ActivityIndicator color={onAmber} /> : <Text style={styles.primaryText}>{label}</Text>}
    </TouchableOpacity>
  );
}

function SecondaryButton({ label, onPress, colors: c }: { label: string; onPress: () => void; colors: ReturnType<typeof useTheme>['colors'] }) {
  return (
    <TouchableOpacity style={[styles.button, styles.secondaryButton, { backgroundColor: c.paper, borderColor: c.line }]} onPress={onPress} accessibilityRole="button">
      <Text style={[styles.secondaryText, { color: c.ink2 }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function LinkButton({ label, onPress, color, testID }: { label: string; onPress: () => void; color: string; testID?: string }) {
  return (
    <TouchableOpacity style={styles.linkButton} onPress={onPress} accessibilityRole="button" testID={testID}>
      <Text style={[styles.linkText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function InfoRow({ title, body, icon, colors: c }: { title: string; body: string; icon: IconName; colors: ReturnType<typeof useTheme>['colors'] }) {
  return (
    <View style={[styles.infoRow, { borderBottomColor: c.line }]}>
      <Ionicons name={icon} size={21} color={c.amberDeep} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowTitle, { color: c.ink }]}>{title}</Text>
        <Text style={[styles.rowBody, { color: c.ink3 }]}>{body}</Text>
      </View>
    </View>
  );
}

function ToggleRow({
  title,
  body,
  icon,
  value,
  onChange,
  disabled,
  colors: c,
  testID,
}: {
  title: string;
  body: string;
  icon: IconName;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
  testID: string;
}) {
  return (
    <View style={styles.toggleRow}>
      <Ionicons name={icon} size={22} color={c.amberDeep} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowTitle, { color: c.ink }]}>{title}</Text>
        <Text style={[styles.rowBody, { color: c.ink3 }]}>{body}</Text>
      </View>
      <NativeSwitch colors={c} value={value} onValueChange={onChange} disabled={disabled} accessibilityLabel={`Back up ${title.toLowerCase()}`} testID={testID} />
    </View>
  );
}

function Notice({ text, colors: c }: { text: string; colors: ReturnType<typeof useTheme>['colors'] }) {
  return (
    <View style={[styles.notice, { backgroundColor: c.amberBg, borderColor: c.line }]}>
      <Text style={[styles.noticeText, { color: c.ink2 }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { minHeight: 48, paddingHorizontal: spacing.xl, paddingBottom: spacing.sm, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  progress: { fontFamily: fonts.mono, fontSize: 12 },
  skip: { fontSize: 14, fontWeight: '600' },
  stepScroll: { flex: 1 },
  stepContent: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.lg },
  loadingState: { minHeight: 220, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm },
  title: { fontSize: 24, lineHeight: 29, fontWeight: '700', marginTop: spacing.lg, marginBottom: 6 },
  subtitle: { fontSize: 14, lineHeight: 20, marginBottom: spacing.lg },
  illustration: { minHeight: 190, borderRadius: radii.xl, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  illustrationCompact: { minHeight: 130 },
  illustrationIcon: { width: 64, height: 64, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  smallIcon: { width: 56, height: 56, borderRadius: radii.xl, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  button: { minHeight: 48, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
  primaryText: { color: onAmber, fontSize: 15, fontWeight: '800' },
  secondaryButton: { marginTop: spacing.sm, borderWidth: 1 },
  secondaryText: { fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  linkButton: { minHeight: 42, alignItems: 'center', justifyContent: 'center' },
  linkText: { fontSize: 13, fontWeight: '600' },
  sectionLabel: { fontSize: 11, letterSpacing: 0.7, textTransform: 'uppercase', marginTop: spacing.sm, marginBottom: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: { borderWidth: 1, borderRadius: radii.round, paddingVertical: 8, paddingHorizontal: 11 },
  card: { borderWidth: 1, borderRadius: radii.lg, overflow: 'hidden' },
  importantCard: { borderWidth: 2, borderRadius: radii.lg, padding: spacing.md, marginBottom: spacing.md },
  infoRow: { minHeight: 64, paddingVertical: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  toggleRow: { minHeight: 70, padding: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 48 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowBody: { fontSize: 12.5, lineHeight: 18, marginTop: 2 },
  notice: { borderWidth: 1, borderRadius: radii.md, paddingVertical: 10, paddingHorizontal: spacing.md, marginTop: spacing.sm },
  noticeText: { fontSize: 12.5, lineHeight: 18 },
  error: { marginHorizontal: spacing.xl, borderWidth: 1, borderRadius: radii.md, padding: spacing.sm },
  errorText: { fontSize: 13, lineHeight: 18 },
  filesIllustration: { minHeight: 160, paddingVertical: spacing.md, borderWidth: 1, borderRadius: radii.xl, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  filesPanel: { width: '82%', borderWidth: 1, borderRadius: radii.lg, padding: spacing.sm },
  filesRow: { fontSize: 12, paddingVertical: 6, paddingHorizontal: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  filesHighlight: { minHeight: 34, borderRadius: radii.md, paddingHorizontal: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  doneRow: { minHeight: 52, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
