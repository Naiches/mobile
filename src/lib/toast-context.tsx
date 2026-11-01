import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import ToastOverlay from '../components/Toast';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToastType = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onPress: () => void | Promise<void>;
}

export interface ToastMessage {
  id: number;
  /** Stable operation key. A later toast with the same key replaces this one. */
  key?: string;
  type: ToastType;
  message: string;
  /** Optional trailing button (e.g. "Show"). A toast with one stays a little longer. */
  action?: ToastAction;
  /** Optional second button (e.g. "View Trash" next to "Undo"). */
  secondaryAction?: ToastAction;
}

export interface ShowToastOptions {
  key?: string;
  type: ToastType;
  message: string;
  action?: ToastAction;
  secondaryAction?: ToastAction;
}

interface ToastContextValue {
  showToast: (opts: ShowToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = useState<ToastMessage | null>(null);
  const currentRef = useRef<ToastMessage | null>(null);
  const queue = useRef<ToastMessage[]>([]);
  const isShowing = useRef(false);

  const showNext = useCallback(() => {
    const next = queue.current.shift();
    if (next) {
      currentRef.current = next;
      setCurrent(next);
      isShowing.current = true;
    } else {
      currentRef.current = null;
      setCurrent(null);
      isShowing.current = false;
    }
  }, []);

  const showToast = useCallback(({ key, type, message, action, secondaryAction }: ShowToastOptions) => {
    const msg: ToastMessage = { id: ++nextId, key, type, message, action, secondaryAction };
    if (key && currentRef.current?.key === key) {
      currentRef.current = msg;
      setCurrent(msg);
      return;
    }
    if (key) {
      const queuedIndex = queue.current.findIndex((item) => item.key === key);
      if (queuedIndex >= 0) {
        queue.current[queuedIndex] = msg;
        return;
      }
    }
    if (isShowing.current) {
      queue.current.push(msg);
    } else {
      currentRef.current = msg;
      setCurrent(msg);
      isShowing.current = true;
    }
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {current && (
        <ToastOverlay key={current.id} toast={current} onDismiss={showNext} />
      )}
    </ToastContext.Provider>
  );
}
