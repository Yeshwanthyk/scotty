export interface VisibilitySource {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export type VisibilityPoll = (signal: AbortSignal) => Promise<number | undefined>;

export function publishUnlessAborted<T>(
  signal: AbortSignal,
  value: T,
  publish: (value: T) => void,
): void {
  if (!signal.aborted) publish(value);
}

export function startVisibilityPolling(
  visibility: VisibilitySource,
  poll: VisibilityPoll,
): { readonly refresh: () => void; readonly stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let running = false;
  let refreshQueued = false;
  const isHidden = (): boolean => visibility.visibilityState === "hidden";

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const run = async (): Promise<void> => {
    clearTimer();
    if (stopped || isHidden()) return;
    if (running) {
      refreshQueued = true;
      return;
    }
    running = true;
    const current = new AbortController();
    controller = current;
    let delay: number | undefined;
    try {
      delay = await poll(current.signal);
    } catch {
      delay = undefined;
    } finally {
      running = false;
      if (controller === current) controller = undefined;
    }
    if (stopped || isHidden()) return;
    if (refreshQueued) {
      refreshQueued = false;
      void run();
      return;
    }
    if (current.signal.aborted) return;
    if (delay !== undefined) timer = setTimeout(() => void run(), delay);
  };

  const onVisibilityChange = (): void => {
    clearTimer();
    if (isHidden()) {
      controller?.abort();
      return;
    }
    void run();
  };

  visibility.addEventListener("visibilitychange", onVisibilityChange);
  void run();
  return {
    refresh: () => {
      clearTimer();
      controller?.abort();
      void run();
    },
    stop: () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      visibility.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
