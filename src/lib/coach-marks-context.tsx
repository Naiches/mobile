import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  beginCoachMarks,
  initialCoachMarksState,
  loadCoachMarksState,
  nextCoachMark,
  saveCoachMarksState,
  skipCoachMarks,
  type CoachMarkTarget,
  type CoachMarksState,
} from './coach-marks';
import { measureCoachMarkTarget, type CoachMarkRect, type CoachMarkMeasurable } from './coach-mark-layout';
import { firstRunSecureStorage } from './first-run-storage';

export type { CoachMarkTarget } from './coach-marks';

type MeasurableTarget = CoachMarkMeasurable;

interface CoachMarksValue {
  ready: boolean;
  state: CoachMarksState;
  start: () => Promise<void>;
  next: () => Promise<void>;
  skip: () => Promise<void>;
  replay: () => Promise<void>;
  registerTarget: (target: CoachMarkTarget, node: MeasurableTarget | null) => void;
  measureTarget: (target: CoachMarkTarget) => Promise<CoachMarkRect | null>;
}

const DEFAULT_STATE = initialCoachMarksState();
const CoachMarksContext = createContext<CoachMarksValue>({
  ready: false,
  state: DEFAULT_STATE,
  start: async () => {},
  next: async () => {},
  skip: async () => {},
  replay: async () => {},
  registerTarget: () => {},
  measureTarget: async () => null,
});

export function CoachMarksProvider({
  accountId,
  children,
}: {
  accountId: string | null;
  children: React.ReactNode;
}) {
  const [ready, setReady] = useState(accountId === null);
  const [state, setState] = useState<CoachMarksState>(DEFAULT_STATE);
  const accountRef = useRef(accountId);
  const stateRef = useRef(state);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const targetsRef = useRef<Partial<Record<CoachMarkTarget, MeasurableTarget>>>({});

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
    void loadCoachMarksState(firstRunSecureStorage, accountId).then((loaded) => {
      if (!live || accountRef.current !== accountId) return;
      stateRef.current = loaded;
      setState(loaded);
      setReady(true);
    });
    return () => { live = false; };
  }, [accountId]);

  const transition = useCallback((change: (current: CoachMarksState) => CoachMarksState): Promise<void> => {
    const next = change(stateRef.current);
    stateRef.current = next;
    setState(next);
    const targetAccount = accountRef.current;
    if (!targetAccount) return Promise.resolve();
    writeChainRef.current = writeChainRef.current
      .catch(() => {})
      .then(() => saveCoachMarksState(firstRunSecureStorage, targetAccount, next))
      .catch(() => {});
    return writeChainRef.current;
  }, []);

  const registerTarget = useCallback((target: CoachMarkTarget, node: MeasurableTarget | null) => {
    if (node) targetsRef.current[target] = node;
    else delete targetsRef.current[target];
  }, []);

  const measureTarget = useCallback((target: CoachMarkTarget): Promise<CoachMarkRect | null> => {
    const node = targetsRef.current[target];
    if (!node) return Promise.resolve(null);
    return measureCoachMarkTarget(node);
  }, []);

  const value = useMemo<CoachMarksValue>(() => ({
    ready,
    state,
    start: () => transition(beginCoachMarks),
    next: () => transition(nextCoachMark),
    skip: () => transition(skipCoachMarks),
    replay: () => transition(initialCoachMarksState),
    registerTarget,
    measureTarget,
  }), [measureTarget, ready, registerTarget, state, transition]);

  return <CoachMarksContext.Provider value={value}>{children}</CoachMarksContext.Provider>;
}

export function useCoachMarks(): CoachMarksValue {
  return useContext(CoachMarksContext);
}

export function useCoachMarkTarget(target: CoachMarkTarget): (node: MeasurableTarget | null) => void {
  const { registerTarget } = useCoachMarks();
  return useCallback((node: MeasurableTarget | null) => registerTarget(target, node), [registerTarget, target]);
}
