import type { SessionListProjection, SessionListReadResult } from "./session-list-reader";
import type { SessionModel, SessionReadResult } from "./session-reader";

export type SessionCatalogStatus = "loading" | "ready" | "degraded";

export interface SessionCatalogSnapshot {
  readonly verifiedActors: ReadonlyMap<string, SessionModel>;
  readonly sessions: ReadonlyArray<SessionModel>;
  readonly status: SessionCatalogStatus;
}

export interface SessionCatalogController {
  readonly getSnapshot: () => SessionCatalogSnapshot;
  readonly publishActor: (session: SessionModel) => void;
  readonly seedActor: (session: SessionModel) => boolean;
  readonly refreshActor: (sessionId: string) => Promise<SessionReadResult | undefined>;
  readonly refresh: () => Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly destroy: () => void;
}

interface ActorCorrection {
  readonly generation: number;
  readonly session: SessionModel;
}

interface SessionCatalogControllerOptions {
  readonly readActor: (sessionId: string, signal: AbortSignal) => Promise<SessionReadResult>;
  readonly readList: (signal: AbortSignal) => Promise<SessionListReadResult>;
}

const sameAuthority = (left: SessionModel, right: SessionModel): boolean =>
  JSON.stringify(left.authority) === JSON.stringify(right.authority) &&
  JSON.stringify(left.selection) === JSON.stringify(right.selection) &&
  JSON.stringify(left.runtime) === JSON.stringify(right.runtime) &&
  JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities) &&
  left.display.title === right.display.title &&
  left.display.repository === right.display.repository &&
  left.display.branch === right.display.branch &&
  left.display.defaultBranch === right.display.defaultBranch;

const sessionsFrom = (
  projections: ReadonlyArray<SessionListProjection>,
  corrections: ReadonlyMap<string, ActorCorrection>,
): ReadonlyArray<SessionModel> => {
  const projectedIds = new Set(projections.map(({ session }) => session.id));
  return [
    ...[...corrections.values()]
      .filter(({ session }) => !projectedIds.has(session.id))
      .map(({ session }) => session),
    ...projections.map(({ session }) => corrections.get(session.id)?.session ?? session),
  ];
};

const isAuthorizationFailure = (result: SessionListReadResult | SessionReadResult): boolean =>
  !result.ok &&
  result.failure.kind === "http" &&
  (result.failure.status === 401 || result.failure.status === 403);

export const createSessionCatalogController = (
  options: SessionCatalogControllerOptions,
): SessionCatalogController => {
  let snapshot: SessionCatalogSnapshot = {
    verifiedActors: new Map(),
    sessions: [],
    status: "loading",
  };
  let projections: ReadonlyArray<SessionListProjection> = [];
  let generation = 0;
  let request = 0;
  let activeController: AbortController | undefined;
  const corrections = new Map<string, ActorCorrection>();
  const verifiedActors = new Map<string, SessionModel>();
  const actorGenerations = new Map<string, number>();
  const actorControllers = new Map<string, AbortController>();
  const suppressedUntilProjectionOmitted = new Set<string>();
  const listeners = new Set<() => void>();

  const publish = (next: SessionCatalogSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const publishCurrent = (status: SessionCatalogStatus): void =>
    publish({
      verifiedActors: new Map(verifiedActors),
      sessions: sessionsFrom(projections, corrections),
      status,
    });

  const clearAuthorityCache = (): void => {
    request += 1;
    activeController?.abort();
    for (const [sessionId, controller] of actorControllers) {
      controller.abort();
      actorGenerations.set(sessionId, ++generation);
    }
    actorControllers.clear();
    projections = [];
    corrections.clear();
    verifiedActors.clear();
    suppressedUntilProjectionOmitted.clear();
  };

  const publishActor = (session: SessionModel): void => {
    actorControllers.get(session.id)?.abort();
    const nextGeneration = ++generation;
    actorGenerations.set(session.id, nextGeneration);
    verifiedActors.set(session.id, session);
    suppressedUntilProjectionOmitted.delete(session.id);
    corrections.set(session.id, { generation: nextGeneration, session });
    publishCurrent(snapshot.status === "loading" ? "ready" : snapshot.status);
  };

  const refreshActor = async (sessionId: string): Promise<SessionReadResult | undefined> => {
    const observedGeneration = actorGenerations.get(sessionId) ?? 0;
    actorControllers.get(sessionId)?.abort();
    const controller = new AbortController();
    actorControllers.set(sessionId, controller);
    const result = await options.readActor(sessionId, controller.signal);
    if (controller.signal.aborted || (actorGenerations.get(sessionId) ?? 0) !== observedGeneration)
      return undefined;
    if (actorControllers.get(sessionId) === controller) actorControllers.delete(sessionId);
    if (result.ok) publishActor(result.session);
    else if (isAuthorizationFailure(result)) {
      clearAuthorityCache();
      publishCurrent("degraded");
    } else if (result.failure.kind === "http" && result.failure.status === 404) {
      actorGenerations.set(sessionId, ++generation);
      corrections.delete(sessionId);
      verifiedActors.delete(sessionId);
      suppressedUntilProjectionOmitted.add(sessionId);
      projections = projections.filter(({ session }) => session.id !== sessionId);
      publishCurrent(snapshot.status);
    }
    return result;
  };

  // oxlint-disable-next-line eslint/complexity -- refresh reconciles projection, actor, auth, and tombstone outcomes in one fenced transaction
  const refresh = async (): Promise<void> => {
    const serial = ++request;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const list = await options.readList(controller.signal);
    if (controller.signal.aborted || serial !== request) return;
    if (!list.ok) {
      if (isAuthorizationFailure(list)) {
        clearAuthorityCache();
      }
      publishCurrent("degraded");
      return;
    }

    let nextProjections = list.projections.filter(
      ({ session }) => !suppressedUntilProjectionOmitted.has(session.id),
    );
    for (const sessionId of suppressedUntilProjectionOmitted) {
      if (!list.projections.some(({ session }) => session.id === sessionId))
        suppressedUntilProjectionOmitted.delete(sessionId);
    }
    const projectedById = new Map(
      nextProjections.map((projection) => [projection.session.id, projection]),
    );
    let degraded = false;
    for (const [sessionId, correction] of corrections) {
      const projected = projectedById.get(sessionId)?.session;
      if (projected !== undefined && sameAuthority(projected, correction.session)) {
        corrections.delete(sessionId);
        continue;
      }

      const verified = await options.readActor(sessionId, controller.signal);
      if (controller.signal.aborted || serial !== request) return;
      if (corrections.get(sessionId)?.generation !== correction.generation) continue;
      if (verified.ok) {
        actorGenerations.set(sessionId, ++generation);
        verifiedActors.set(sessionId, verified.session);
        corrections.set(sessionId, {
          generation: actorGenerations.get(sessionId) ?? generation,
          session: verified.session,
        });
      } else if (
        verified.failure.kind === "http" &&
        (verified.failure.status === 401 || verified.failure.status === 403)
      ) {
        clearAuthorityCache();
        publishCurrent("degraded");
        return;
      } else if (verified.failure.kind === "http" && verified.failure.status === 404) {
        actorGenerations.set(sessionId, ++generation);
        actorControllers.get(sessionId)?.abort();
        corrections.delete(sessionId);
        verifiedActors.delete(sessionId);
        suppressedUntilProjectionOmitted.add(sessionId);
        nextProjections = nextProjections.filter(({ session }) => session.id !== sessionId);
      } else {
        degraded = true;
      }
    }
    projections = nextProjections.filter(
      ({ session }) => !suppressedUntilProjectionOmitted.has(session.id),
    );
    publishCurrent(degraded ? "degraded" : "ready");
  };

  return {
    getSnapshot: () => snapshot,
    publishActor,
    seedActor: (session) => {
      if (verifiedActors.has(session.id)) return false;
      publishActor(session);
      return true;
    },
    refreshActor,
    refresh,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy: () => {
      request += 1;
      activeController?.abort();
      for (const controller of actorControllers.values()) controller.abort();
      actorControllers.clear();
      listeners.clear();
    },
  };
};
