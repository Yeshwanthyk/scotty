import type { RepositoryGroup } from "../components/Sidebar";
import type { SessionRowProps } from "../components/SessionRow";
import type { SessionModel } from "../data/session-reader";
import {
  archivedSessionIds,
  FIXTURE_NOW,
  manySessions,
  projectionStale,
  sidebarSessions,
} from "../fixtures/sessions";
import { presentSession, reconcileRailSession } from "./session-presentation";

export interface SessionRail {
  readonly archivedSessions: ReadonlyArray<SessionRowProps>;
  readonly repositories: ReadonlyArray<RepositoryGroup>;
}

interface RailFixture {
  readonly actor?: SessionModel;
  readonly projected: SessionModel;
}

const fixtureRailSessions: ReadonlyArray<RailFixture> = [
  ...sidebarSessions.map((projected) => ({ projected })),
  ...manySessions.map((projected) => ({ projected })),
  { projected: projectionStale.projected, actor: projectionStale.actor },
];

const rowFor = (
  { projected, actor }: RailFixture,
  selectedSession?: SessionModel,
): SessionRowProps => {
  const selected = selectedSession?.id === projected.id;
  const currentActor = selected ? selectedSession : actor;
  const hasActorRead = currentActor !== undefined && currentActor.id === projected.id;
  const actorCorrected =
    hasActorRead && JSON.stringify(currentActor.authority) !== JSON.stringify(projected.authority);
  const session = hasActorRead ? reconcileRailSession(projected, currentActor) : projected;
  const projectedPresentation = presentSession(projected, {
    now: FIXTURE_NOW,
    source: "projection",
    freshness: actorCorrected ? "stale" : "fresh",
  });
  return {
    actorCorrected,
    presentation: hasActorRead
      ? presentSession(session, { now: FIXTURE_NOW, source: "actor" })
      : projectedPresentation,
    projectedFreshness: projectedPresentation.freshness,
    selected,
    session,
  };
};

export const buildFixtureSessionRail = (selectedSession?: SessionModel): SessionRail => {
  const repositoryGroups = new Map<string, SessionRowProps[]>();
  const archivedSessions: SessionRowProps[] = [];

  for (const fixture of fixtureRailSessions) {
    const row = rowFor(fixture, selectedSession);
    if (
      row.presentation.authority.kind === "stable" &&
      row.presentation.authority.lifecycle === "gone"
    )
      continue;
    if (archivedSessionIds.has(row.session.id)) {
      archivedSessions.push({ ...row, placement: "archived" });
      continue;
    }
    const sessions = repositoryGroups.get(row.session.display.repository) ?? [];
    sessions.push(row);
    repositoryGroups.set(row.session.display.repository, sessions);
  }

  return {
    archivedSessions,
    repositories: [...repositoryGroups].map(([name, sessions]) => ({ name, sessions })),
  };
};
