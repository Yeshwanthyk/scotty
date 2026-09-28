import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { message, sessions, type Session } from "./core";
import { startVisibilityPolling } from "./visibility-polling";

type Store = {
  list: ReadonlyArray<Session> | undefined;
  error: string;
  refresh: () => void;
};

const Context = createContext<Store>({ list: undefined, error: "", refresh: () => undefined });

// One poll of the session list feeds the sidebar, the phone home and Cmd-K.
export function SessionsProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ReadonlyArray<Session>>();
  const [error, setError] = useState("");
  const refresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    const polling = startVisibilityPolling(document, async (signal) => {
      try {
        const next = await sessions(signal);
        if (!signal.aborted) {
          setList(next);
          setError("");
        }
      } catch (failure) {
        if (!signal.aborted) setError(message(failure, "Could not load sessions"));
      }
      return 3000;
    });
    refresh.current = polling.refresh;
    return () => polling.stop();
  }, []);
  return (
    <Context.Provider value={{ list, error, refresh: () => refresh.current() }}>
      {children}
    </Context.Provider>
  );
}

export const useSessions = () => useContext(Context);
