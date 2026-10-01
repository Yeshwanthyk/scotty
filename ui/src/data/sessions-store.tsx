import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { decodeListFrame, message, sessions, type ListFrame, type Session } from "./core";
import { openLive } from "./live";

type Store = {
  list: ReadonlyArray<Session> | undefined;
  error: string;
  refresh: () => void;
  // Set from Cmd-K: the sidebar then lists only this repository.
  repo: string;
  setRepo: (repo: string) => void;
};

const firstDelay = 1000;
const maxDelay = 30_000;

const Context = createContext<Store>({
  list: undefined,
  error: "",
  refresh: () => undefined,
  repo: "",
  setRepo: () => undefined,
});

const apply = (list: ReadonlyArray<Session>, frame: ListFrame): ReadonlyArray<Session> => {
  if (frame.kind === "removed") return list.filter((item) => item.identity.id !== frame.id);
  const id = frame.session.identity.id;
  return list.some((item) => item.identity.id === id)
    ? list.map((item) => (item.identity.id === id ? frame.session : item))
    : [frame.session, ...list];
};

// One live list feeds the sidebar, the phone home and Cmd-K: read once on each connect, then
// kept current by pushed frames.
export function SessionsProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ReadonlyArray<Session>>();
  const [error, setError] = useState("");
  const [repo, setRepo] = useState("");
  const refresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    let stopped = false;
    // Frames that arrive while the list is being read are applied on top of it.
    let pending: ListFrame[] | undefined;
    // A failed read is retried with backoff while the socket stays open; frames alone can't
    // rebuild the list.
    let connected = false;
    let delay = firstDelay;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(retry);
      const frames: ListFrame[] = [];
      pending = frames;
      try {
        const next = await sessions();
        // Only the latest read counts.
        if (stopped || pending !== frames) return;
        setList(frames.reduce(apply, next));
        setError("");
        delay = firstDelay;
      } catch (failure) {
        if (stopped || pending !== frames) return;
        setError(message(failure, "Could not load sessions"));
        if (connected) retry = setTimeout(() => void load(), delay);
        delay = Math.min(delay * 2, maxDelay);
      } finally {
        if (pending === frames) pending = undefined;
      }
    };
    const live = openLive("/api/sessions/live", decodeListFrame, {
      open: () => {
        connected = true;
        delay = firstDelay;
        void load();
      },
      connection: (state) => {
        connected = state === "open";
        if (!connected) clearTimeout(retry);
      },
      frame: (frame) => {
        pending?.push(frame);
        setList((current) => (current === undefined ? current : apply(current, frame)));
      },
    });
    refresh.current = () => {
      live.reconnect();
      void load();
    };
    return () => {
      stopped = true;
      clearTimeout(retry);
      live.stop();
    };
  }, []);
  return (
    <Context.Provider value={{ list, error, refresh: () => refresh.current(), repo, setRepo }}>
      {children}
    </Context.Provider>
  );
}

export const useSessions = () => useContext(Context);
