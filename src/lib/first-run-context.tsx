import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  advanceFirstRun,
  completeFirstRun,
  dismissFirstRunCard,
  initialFirstRunState,
  loadFirstRunState,
  markFirstRunAccountActive,
  markFirstRunItemDone,
  markFirstRunItemsRemaining,
  reopenFirstRun,
  resumeFirstRun,
  saveFirstRunState,
  skipFirstRun,
  type FirstRunItem,
  type FirstRunState,
} from './first-run-setup';
import { firstRunSecureStorage } from './first-run-storage';

interface FirstRunSetupValue {
  ready: boolean;
  state: FirstRunState;
  shouldShowWizard: boolean;
  shouldShowFinishCard: boolean;
  advance: () => Promise<void>;
  skip: () => Promise<void>;
  markDone: (item: FirstRunItem) => Promise<void>;
  markRemaining: (items: readonly FirstRunItem[]) => Promise<void>;
  complete: () => Promise<void>;
  resume: () => Promise<void>;
  reopen: () => Promise<void>;
  dismissCard: () => Promise<void>;
}

const DEFAULT_STATE = initialFirstRunState();
const FirstRunSetupContext = createContext<FirstRunSetupValue>({
  ready: false,
  state: DEFAULT_STATE,
  shouldShowWizard: false,
  shouldShowFinishCard: false,
  advance: async () => {},
  skip: async () => {},
  markDone: async () => {},
  markRemaining: async () => {},
  complete: async () => {},
  resume: async () => {},
  reopen: async () => {},
  dismissCard: async () => {},
});

export function FirstRunSetupProvider({
  accountId,
  children,
}: {
  accountId: string | null;
  children: React.ReactNode;
}) {
  const [ready, setReady] = useState(accountId === null);
  const [state, setState] = useState<FirstRunState>(DEFAULT_STATE);
  const stateRef = useRef(state);
  const accountRef = useRef(accountId);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let live = true;
    accountRef.current = accountId;
    stateRef.current = DEFAULT_STATE;
    setState(DEFAULT_STATE);
    if (!accountId) {
      setReady(true);
      return () => { live = false; };
    }

    setReady(false);
    void Promise.all([
      loadFirstRunState(firstRunSecureStorage, accountId),
      markFirstRunAccountActive(firstRunSecureStorage, accountId).catch(() => {}),
    ]).then(([loaded]) => {
      if (!live || accountRef.current !== accountId) return;
      stateRef.current = loaded;
      setState(loaded);
      setReady(true);
    });
    return () => { live = false; };
  }, [accountId]);

  const transition = useCallback((change: (current: FirstRunState) => FirstRunState): Promise<void> => {
    const next = change(stateRef.current);
    stateRef.current = next;
    setState(next);
    const targetAccount = accountRef.current;
    if (!targetAccount) return Promise.resolve();
    writeChainRef.current = writeChainRef.current
      .catch(() => {})
      .then(() => saveFirstRunState(firstRunSecureStorage, targetAccount, next))
      .catch(() => {});
    return writeChainRef.current;
  }, []);

  const value = useMemo<FirstRunSetupValue>(() => ({
    ready,
    state,
    shouldShowWizard: ready && !!accountId && !state.completed,
    shouldShowFinishCard: ready && state.completed && state.remaining.length > 0 && !state.finishCardDismissed,
    advance: () => transition(advanceFirstRun),
    skip: () => transition(skipFirstRun),
    markDone: (item) => transition((current) => markFirstRunItemDone(current, item)),
    markRemaining: (items) => transition((current) => markFirstRunItemsRemaining(current, items)),
    complete: () => transition(completeFirstRun),
    resume: () => transition(resumeFirstRun),
    reopen: () => transition(reopenFirstRun),
    dismissCard: () => transition(dismissFirstRunCard),
  }), [accountId, ready, state, transition]);

  return <FirstRunSetupContext.Provider value={value}>{children}</FirstRunSetupContext.Provider>;
}

export function useFirstRunSetup(): FirstRunSetupValue {
  return useContext(FirstRunSetupContext);
}
