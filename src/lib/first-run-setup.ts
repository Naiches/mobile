export const FIRST_RUN_STATE_VERSION = 1 as const;
export const FIRST_RUN_STATE_KEY_PREFIX = 'beebeeb.first_run_setup.v1.';
export const ACTIVE_FIRST_RUN_ACCOUNT_KEY = 'beebeeb.first_run_setup.active_account';

export type FirstRunScreen =
  | 'app-lock'
  | 'photo-backup'
  | 'contacts-calendar'
  | 'files-notifications'
  | 'done';

export type FirstRunItem =
  | 'app-lock'
  | 'photo-backup'
  | 'contacts'
  | 'calendar'
  | 'notifications';

export type FirstRunSettingsCategory = 'security' | 'backups' | 'notifications';

export const FIRST_RUN_ITEM_LABELS: Record<FirstRunItem, string> = {
  'app-lock': 'app lock',
  'photo-backup': 'photo backup',
  contacts: 'contacts',
  calendar: 'calendar',
  notifications: 'notifications',
};

export const FIRST_RUN_ITEM_CATEGORIES: Record<FirstRunItem, FirstRunSettingsCategory> = {
  'app-lock': 'security',
  'photo-backup': 'backups',
  contacts: 'backups',
  calendar: 'backups',
  notifications: 'notifications',
};

export interface FirstRunState {
  version: typeof FIRST_RUN_STATE_VERSION;
  completed: boolean;
  screen: FirstRunScreen;
  remaining: FirstRunItem[];
  finishCardDismissed: boolean;
}

export interface FirstRunStorage {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<unknown>;
  deleteItemAsync: (key: string) => Promise<unknown>;
}

const SCREENS: readonly FirstRunScreen[] = [
  'app-lock',
  'photo-backup',
  'contacts-calendar',
  'files-notifications',
  'done',
];

const ITEMS: readonly FirstRunItem[] = [
  'app-lock',
  'photo-backup',
  'contacts',
  'calendar',
  'notifications',
];

const NEXT_SCREEN: Record<FirstRunScreen, FirstRunScreen> = {
  'app-lock': 'photo-backup',
  'photo-backup': 'contacts-calendar',
  'contacts-calendar': 'files-notifications',
  'files-notifications': 'done',
  done: 'done',
};

const SKIPPED_ITEMS: Partial<Record<FirstRunScreen, readonly FirstRunItem[]>> = {
  'app-lock': ['app-lock'],
  'photo-backup': ['photo-backup'],
  'contacts-calendar': ['contacts', 'calendar'],
  'files-notifications': ['notifications'],
};

const ITEM_SCREEN: Record<FirstRunItem, FirstRunScreen> = {
  'app-lock': 'app-lock',
  'photo-backup': 'photo-backup',
  contacts: 'contacts-calendar',
  calendar: 'contacts-calendar',
  notifications: 'files-notifications',
};

export function initialFirstRunState(): FirstRunState {
  return {
    version: FIRST_RUN_STATE_VERSION,
    completed: false,
    screen: 'app-lock',
    remaining: [],
    finishCardDismissed: false,
  };
}

export function firstRunPosition(screen: FirstRunScreen): { position: number; total: 5 } | null {
  const position = ['app-lock', 'photo-backup', 'contacts-calendar', 'files-notifications', 'done'].indexOf(screen);
  return position === -1 ? null : { position: position + 1, total: 5 };
}

function orderedItems(items: readonly FirstRunItem[]): FirstRunItem[] {
  const selected = new Set(items);
  return ITEMS.filter((item) => selected.has(item));
}

export function advanceFirstRun(state: FirstRunState): FirstRunState {
  return { ...state, screen: NEXT_SCREEN[state.screen] };
}

export function skipFirstRun(state: FirstRunState): FirstRunState {
  const skipped = SKIPPED_ITEMS[state.screen] ?? [];
  return {
    ...state,
    screen: NEXT_SCREEN[state.screen],
    remaining: orderedItems([...state.remaining, ...skipped]),
  };
}

export function markFirstRunItemDone(state: FirstRunState, item: FirstRunItem): FirstRunState {
  return { ...state, remaining: state.remaining.filter((candidate) => candidate !== item) };
}

export function markFirstRunItemsRemaining(
  state: FirstRunState,
  items: readonly FirstRunItem[],
): FirstRunState {
  return { ...state, remaining: orderedItems([...state.remaining, ...items]) };
}

export function firstRunSummaryItemLinksToSettings(
  state: FirstRunState,
  item: FirstRunItem,
  enabled: boolean,
): boolean {
  return state.remaining.includes(item) || !enabled;
}

export function photoPermissionNeedsSettings(permission: {
  status?: string;
  accessPrivileges?: string | null;
  canAskAgain?: boolean;
} | null | undefined): boolean {
  if (!permission || permission.status === 'undetermined') return false;
  const hasNoAccess = permission.status === 'denied' || permission.accessPrivileges === 'none';
  return hasNoAccess && permission.canAskAgain !== true;
}

export function completeFirstRun(state: FirstRunState): FirstRunState {
  return { ...state, completed: true, screen: 'done', finishCardDismissed: false };
}

export function dismissFirstRunCard(state: FirstRunState): FirstRunState {
  return { ...state, finishCardDismissed: true };
}

export function resumeFirstRun(state: FirstRunState): FirstRunState {
  const first = state.remaining[0];
  return {
    ...state,
    completed: false,
    screen: first ? ITEM_SCREEN[first] : 'app-lock',
    finishCardDismissed: false,
  };
}

export function reopenFirstRun(state: FirstRunState): FirstRunState {
  return {
    ...state,
    completed: false,
    screen: 'app-lock',
    finishCardDismissed: false,
  };
}

export function firstRunStateKey(accountId: string): string {
  return `${FIRST_RUN_STATE_KEY_PREFIX}${accountId}`;
}

function isFirstRunState(value: unknown): value is FirstRunState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<FirstRunState>;
  return state.version === FIRST_RUN_STATE_VERSION &&
    typeof state.completed === 'boolean' &&
    typeof state.finishCardDismissed === 'boolean' &&
    typeof state.screen === 'string' &&
    SCREENS.includes(state.screen as FirstRunScreen) &&
    Array.isArray(state.remaining) &&
    state.remaining.every((item) => ITEMS.includes(item));
}

export async function loadFirstRunState(
  storage: Pick<FirstRunStorage, 'getItemAsync'>,
  accountId: string,
): Promise<FirstRunState> {
  try {
    const raw = await storage.getItemAsync(firstRunStateKey(accountId));
    if (!raw) return initialFirstRunState();
    const parsed: unknown = JSON.parse(raw);
    if (!isFirstRunState(parsed)) return initialFirstRunState();
    return { ...parsed, remaining: orderedItems(parsed.remaining) };
  } catch {
    return initialFirstRunState();
  }
}

export async function saveFirstRunState(
  storage: Pick<FirstRunStorage, 'setItemAsync'>,
  accountId: string,
  state: FirstRunState,
): Promise<void> {
  await storage.setItemAsync(firstRunStateKey(accountId), JSON.stringify(state));
}

export async function markFirstRunAccountActive(
  storage: Pick<FirstRunStorage, 'setItemAsync'>,
  accountId: string,
): Promise<void> {
  await storage.setItemAsync(ACTIVE_FIRST_RUN_ACCOUNT_KEY, accountId);
}

export async function clearActiveFirstRunAccount(
  storage: Pick<FirstRunStorage, 'getItemAsync' | 'deleteItemAsync'>,
  accountId: string,
): Promise<void> {
  const active = await storage.getItemAsync(ACTIVE_FIRST_RUN_ACCOUNT_KEY).catch(() => null);
  if (active === accountId) await storage.deleteItemAsync(ACTIVE_FIRST_RUN_ACCOUNT_KEY);
}
