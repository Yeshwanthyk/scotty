// One live socket: the server pushes, the client only listens. It reconnects with backoff, and at
// once when the tab shows again or the network returns. A clean close from the server (the
// session was deleted) is final.
export type Connection = "connecting" | "open" | "reconnecting";

const firstDelay = 1000;
const maxDelay = 30_000;
// A short drop is not worth mentioning.
const quietFor = 3000;
// The server only pushes on change, so a socket that slept with the phone can look open while
// dead. After this long hidden it is replaced, and the new one starts with a fresh snapshot.
const staleAfter = 30_000;

export function openLive<A>(
  path: string,
  decode: (value: unknown) => A | undefined,
  on: {
    readonly frame: (frame: A) => void;
    readonly open?: () => void;
    readonly connection?: (state: Connection) => void;
    readonly ended?: () => void;
  },
): { readonly reconnect: () => void; readonly stop: () => void } {
  let socket: WebSocket | undefined;
  let open = false;
  let opened = false;
  let stopped = false;
  let delay = firstDelay;
  let hiddenAt: number | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let reported: Connection = "open";
  const report = (state: Connection) => {
    if (state === reported) return;
    reported = state;
    on.connection?.(state);
  };
  const watchQuiet = () => {
    if (quiet === undefined)
      quiet = setTimeout(() => report(opened ? "reconnecting" : "connecting"), quietFor);
  };

  const connect = () => {
    clearTimeout(retry);
    retry = undefined;
    if (stopped) return;
    const url = new URL(path, window.location.href);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    const current = new WebSocket(url);
    socket = current;
    watchQuiet();
    current.addEventListener("open", () => {
      if (socket !== current) return;
      open = true;
      opened = true;
      delay = firstDelay;
      clearTimeout(quiet);
      quiet = undefined;
      report("open");
      on.open?.();
    });
    current.addEventListener("message", (event) => {
      if (socket !== current || typeof event.data !== "string") return;
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      const frame = decode(value);
      if (frame !== undefined) on.frame(frame);
    });
    current.addEventListener("close", (event) => {
      if (socket !== current) return;
      socket = undefined;
      open = false;
      if (stopped) return;
      if (event.code === 1000) {
        stop();
        on.ended?.();
        return;
      }
      watchQuiet();
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, maxDelay);
    });
  };

  // A socket that is neither open nor connecting is replaced now rather than after its backoff.
  const reconnect = () => {
    if (stopped || open || (socket !== undefined && socket.readyState === WebSocket.CONNECTING))
      return;
    connect();
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    const stale = hiddenAt !== undefined && Date.now() - hiddenAt > staleAfter;
    hiddenAt = undefined;
    if (!stale) return reconnect();
    if (stopped) return;
    const old = socket;
    socket = undefined;
    open = false;
    old?.close();
    connect();
  };
  const stop = () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(quiet);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", reconnect);
    socket?.close();
    socket = undefined;
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", reconnect);
  connect();
  return { reconnect, stop };
}
