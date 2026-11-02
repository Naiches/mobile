export interface PhotoPreviewToggleRequest {
  nextEnabled: boolean;
  confirmTurnOff: (actions: { confirm: () => void; cancel: () => void }) => void;
  setOptimistic: () => void;
  run: () => Promise<void>;
  onPending?: () => void;
  onError?: (error: unknown) => void;
  onSettled?: () => void;
}

export interface PhotoPreviewToggleCoordinator {
  request: (request: PhotoPreviewToggleRequest) => boolean;
  isPending: () => boolean;
}

/**
 * Serialises switch gestures without putting slow storage or network work in front
 * of feedback. Turning on changes the controlled switch immediately. Turning off
 * opens one confirmation immediately, then changes it as soon as the user confirms.
 */
export function createPhotoPreviewToggleCoordinator(): PhotoPreviewToggleCoordinator {
  let pending = false;

  const request = (next: PhotoPreviewToggleRequest): boolean => {
    if (pending) return false;
    pending = true;
    next.onPending?.();
    let decided = false;

    const settle = () => {
      if (!pending) return;
      pending = false;
      next.onSettled?.();
    };

    const run = () => {
      if (decided) return;
      decided = true;
      next.setOptimistic();
      try {
        void Promise.resolve(next.run())
          .catch((error) => { next.onError?.(error); })
          .finally(settle);
      } catch (error) {
        next.onError?.(error);
        settle();
      }
    };

    const cancel = () => {
      if (decided) return;
      decided = true;
      settle();
    };

    if (next.nextEnabled) {
      run();
      return true;
    }

    try {
      next.confirmTurnOff({ confirm: run, cancel });
    } catch (error) {
      next.onError?.(error);
      cancel();
    }
    return true;
  };

  return { request, isPending: () => pending };
}
