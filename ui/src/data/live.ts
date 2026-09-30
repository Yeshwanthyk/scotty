// One live socket: the server pushes, the client only listens. It reconnects with backoff, and at
// once when the tab shows again or the network returns.
export type Connection = "open" | "reconnecting";

const firstDelay = 1000;
const maxDelay = 30_000;
// A short drop is not worth mentioning.
const quietFor = 3000;

export function openLive<A>(
  path: string,
  decode: (value: unknown) => A | undefined,
  on: {
    readonly frame: (frame: A) => void;
    readonly open?: () => void;
    readonly connection?: (state: Connection) => void;
  },
): { readonly reconnect: () => void; readonly stop: () => void } {
  let socket: WebSocket | undefined;
  let open = false;
  let stopped = false;
  let delay = firstDelay;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let reported: Connection = "open";
  const report = (state: Connection) => {
    if (state === reported) return;
    reported = state;
    on.connection?.(state);
  };
  const watchQuiet = () => {
    if (quiet === undefined) quiet = setTimeout(() => report("reconnecting"), quietFor);
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
    current.addEventListener("close", () => {
      if (socket !== current) return;
      socket = undefined;
      open = false;
      if (stopped) return;
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
  const onVisible = () => {
    if (document.visibilityState === "visible") reconnect();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", reconnect);
  connect();
  return {
    reconnect,
    stop: () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(quiet);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconnect);
      socket?.close();
      socket = undefined;
    },
  };
}
