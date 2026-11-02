import type { FirstRunStorage } from './first-run-setup';

export const COACH_MARKS_STATE_VERSION = 1 as const;
export const COACH_MARKS_STATE_KEY_PREFIX = 'beebeeb.coach_marks.v1.';

export const COACH_MARK_STEPS = ['drive', 'photos', 'shared', 'settings'] as const;
export type CoachMarkStep = typeof COACH_MARK_STEPS[number];
export type CoachMarkTarget = 'photos-sources';

/** A tab is the target unless its copy explicitly describes one control inside it. */
export function coachMarkTargetForStep(step: CoachMarkStep): CoachMarkTarget | null {
  return step === 'photos' ? 'photos-sources' : null;
}

export const COACH_MARK_COPY: Record<CoachMarkStep, { title: string; body: string }> = {
  drive: { title: 'Drive', body: 'Your files, encrypted on this phone before they are stored.' },
  photos: { title: 'Photos', body: 'Your camera roll, plus any folders you pick as sources.' },
  shared: { title: 'Shared', body: 'Share a file or folder with someone so only they can open it.' },
  settings: { title: 'Settings', body: 'Backups, app lock and devices are all here, and you can change anything later.' },
};

export interface CoachMarksState {
  version: typeof COACH_MARKS_STATE_VERSION;
  status: 'idle' | 'active' | 'done';
  step: CoachMarkStep | null;
}

export function initialCoachMarksState(): CoachMarksState {
  return { version: COACH_MARKS_STATE_VERSION, status: 'idle', step: null };
}

/** Begin once. A Settings replay resets to `idle` before the wizard runs again. */
export function beginCoachMarks(state: CoachMarksState): CoachMarksState {
  if (state.status !== 'idle') return state;
  return { version: COACH_MARKS_STATE_VERSION, status: 'active', step: 'drive' };
}

export function nextCoachMark(state: CoachMarksState): CoachMarksState {
  if (state.status !== 'active' || state.step == null) return state;
  const index = COACH_MARK_STEPS.indexOf(state.step);
  const next = COACH_MARK_STEPS[index + 1];
  return next
    ? { ...state, step: next }
    : { ...state, status: 'done', step: null };
}

export function skipCoachMarks(state: CoachMarksState): CoachMarksState {
  return { ...state, status: 'done', step: null };
}

/** Keep a just-finished setup's Drive tip queued while its Settings link is open. */
export function coachMarksCanPresentOnRoute(state: CoachMarksState, routeName: string | null): boolean {
  if (state.status !== 'active' || state.step == null) return false;
  // `complete()` updates synchronously before the wizard's navigation.replace
  // commits. Only mount over a real tab leaf, never over the departing wizard
  // (or a root-stack modal that happens to be current during replay).
  if (!routeName || !['Drive', 'Folder', 'Photos', 'Shared', 'Settings'].includes(routeName)) return false;
  return !(state.step === 'drive' && routeName === 'Settings');
}

export function coachMarksStateKey(accountId: string): string {
  return `${COACH_MARKS_STATE_KEY_PREFIX}${accountId}`;
}

function isCoachMarksState(value: unknown): value is CoachMarksState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<CoachMarksState>;
  return state.version === COACH_MARKS_STATE_VERSION &&
    (state.status === 'idle' || state.status === 'active' || state.status === 'done') &&
    (state.step == null || COACH_MARK_STEPS.includes(state.step));
}

export async function loadCoachMarksState(
  storage: Pick<FirstRunStorage, 'getItemAsync'>,
  accountId: string,
): Promise<CoachMarksState> {
  try {
    const raw = await storage.getItemAsync(coachMarksStateKey(accountId));
    if (!raw) return initialCoachMarksState();
    const parsed: unknown = JSON.parse(raw);
    return isCoachMarksState(parsed) ? parsed : initialCoachMarksState();
  } catch {
    return initialCoachMarksState();
  }
}

export async function saveCoachMarksState(
  storage: Pick<FirstRunStorage, 'setItemAsync'>,
  accountId: string,
  state: CoachMarksState,
): Promise<void> {
  await storage.setItemAsync(coachMarksStateKey(accountId), JSON.stringify(state));
}
