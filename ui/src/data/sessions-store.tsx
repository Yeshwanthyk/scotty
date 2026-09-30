import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { decodeListFrame, message, sessions, type ListFrame, type Session } from "./core";
import { openLive } from "./live";

type Store = {
  list: ReadonlyArray<Session> | undefined;
  error: string;
  refresh: () => void;
};

const Context = createContext<Store>({ list: undefined, error: "", refresh: () => undefined });

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
  const refresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    let stopped = false;
    // Frames that arrive while the list is being read are applied on top of it.
    let pending: ListFrame[] | undefined;
    const load = async () => {
      const frames: ListFrame[] = [];
      pending = frames;
      try {
        const next = await sessions();
        // Only the latest read counts.
        if (stopped || pending !== frames) return;
        setList(frames.reduce(apply, next));
        setError("");
      } catch (failure) {
        if (!stopped && pending === frames) setError(message(failure, "Could not load sessions"));
      } finally {
        if (pending === frames) pending = undefined;
      }
    };
    const live = openLive("/api/sessions/live", decodeListFrame, {
      open: () => void load(),
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
      live.stop();
    };
  }, []);
  return (
    <Context.Provider value={{ list, error, refresh: () => refresh.current() }}>
      {children}
    </Context.Provider>
  );
}

export const useSessions = () => useContext(Context);
