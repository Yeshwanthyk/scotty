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

export interface BuildSessionRailOptions {
  readonly archivedIds?: ReadonlySet<string>;
  readonly now?: Date;
  readonly selectedActor?: SessionModel;
}

const fixtureRailSessions: ReadonlyArray<RailFixture> = [
  ...sidebarSessions.map((projected) => ({ projected })),
  ...manySessions.map((projected) => ({ projected })),
  { projected: projectionStale.projected, actor: projectionStale.actor },
];

const rowFor = (
  { projected, actor }: RailFixture,
  selectedSession?: SessionModel,
  now = new Date(),
): SessionRowProps => {
  const selected = selectedSession?.id === projected.id;
  const currentActor = selected ? selectedSession : actor;
  const hasActorRead = currentActor !== undefined && currentActor.id === projected.id;
  const actorCorrected =
    hasActorRead &&
    JSON.stringify({
      authority: currentActor.authority,
      runtime: currentActor.runtime,
      capabilities: currentActor.capabilities,
      display: currentActor.display,
      times: currentActor.times,
    }) !==
      JSON.stringify({
        authority: projected.authority,
        runtime: projected.runtime,
        capabilities: projected.capabilities,
        display: projected.display,
        times: projected.times,
      });
  const session = hasActorRead ? reconcileRailSession(projected, currentActor) : projected;
  const projectedPresentation = presentSession(projected, {
    now,
    source: "projection",
    freshness: actorCorrected ? "stale" : "fresh",
  });
  return {
    actorCorrected,
    presentation: hasActorRead
      ? presentSession(session, { now, source: "actor" })
      : projectedPresentation,
    projectedFreshness: projectedPresentation.freshness,
    selected,
    session,
  };
};

const archivedByLifecycle = (row: SessionRowProps): boolean =>
  row.presentation.authority.kind === "stable" &&
  (row.presentation.authority.lifecycle === "sleeping" ||
    row.presentation.authority.lifecycle === "failed");

export const buildSessionRail = (
  projectedSessions: ReadonlyArray<SessionModel>,
  options: BuildSessionRailOptions = {},
): SessionRail => {
  const fixtures = projectedSessions.map((projected) => ({ projected }));
  if (
    options.selectedActor !== undefined &&
    !projectedSessions.some((projected) => projected.id === options.selectedActor?.id)
  )
    fixtures.unshift({ projected: options.selectedActor });

  const activeSessions: SessionRowProps[] = [];
  const archivedSessions: SessionRowProps[] = [];
  for (const fixture of fixtures) {
    const row = rowFor(fixture, options.selectedActor, options.now);
    if (
      row.presentation.authority.kind === "stable" &&
      row.presentation.authority.lifecycle === "gone"
    )
      continue;
    const archived = options.archivedIds?.has(row.session.id) ?? archivedByLifecycle(row);
    if (archived) archivedSessions.push({ ...row, placement: "archived" });
    else activeSessions.push(row);
  }
  return {
    archivedSessions,
    repositories:
      activeSessions.length === 0 ? [] : [{ name: "Sessions", sessions: activeSessions }],
  };
};

export const buildFixtureSessionRail = (selectedSession?: SessionModel): SessionRail => {
  return buildSessionRail(
    fixtureRailSessions.map(({ projected }) => projected),
    { archivedIds: archivedSessionIds, now: FIXTURE_NOW, selectedActor: selectedSession },
  );
};
