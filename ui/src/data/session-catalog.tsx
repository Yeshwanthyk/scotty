import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { sessionFixtureForId, sessionListFixtures } from "../fixtures/sessions";
import { buildSessionRail } from "../domain/session-rail";
import {
  createSessionCatalogController,
  type SessionCatalogController,
} from "./session-catalog-controller";
import { readSessionList } from "./session-list-reader";
import { readAuthoritativeSession, type SessionModel } from "./session-reader";

const SessionCatalogContext = createContext<SessionCatalogController | null>(null);

export function SessionCatalogProvider({ children }: { readonly children: ReactNode }) {
  const [controller] = useState(() =>
    createSessionCatalogController({
      readActor: (sessionId, signal) =>
        readAuthoritativeSession(sessionId, {
          fixture: sessionFixtureForId(sessionId),
          fixtureFallback: import.meta.env.DEV,
          signal,
        }),
      readList: (signal) =>
        readSessionList({
          fixture: sessionListFixtures,
          fixtureFallback: import.meta.env.DEV,
          signal,
        }),
    }),
  );

  useEffect(() => {
    void controller.refresh();
    const refreshForeground = () => {
      if (document.visibilityState === "visible") void controller.refresh();
    };
    const timer = window.setInterval(refreshForeground, 30_000);
    window.addEventListener("focus", refreshForeground);
    document.addEventListener("visibilitychange", refreshForeground);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshForeground);
      document.removeEventListener("visibilitychange", refreshForeground);
      controller.destroy();
    };
  }, [controller]);

  return <SessionCatalogContext value={controller}>{children}</SessionCatalogContext>;
}

export const useSessionCatalog = () => {
  const controller = useContext(SessionCatalogContext);
  if (controller === null) throw new Error("useSessionCatalog requires SessionCatalogProvider");
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return {
    ...snapshot,
    publishActor: controller.publishActor,
    seedActor: controller.seedActor,
    refresh: controller.refresh,
    refreshActor: controller.refreshActor,
    rail: buildSessionRail(snapshot.sessions),
  };
};

export const usePublishSessionActor = (): ((session: SessionModel) => void) =>
  useSessionCatalog().publishActor;
