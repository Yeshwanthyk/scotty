import type {
  SessionAuthority,
  SessionCapabilities,
  SessionLifecycle,
  SessionModel,
  SessionTransitionAction,
} from "../data/session-reader";

export const FIXTURE_NOW = new Date("2026-09-03T16:00:00.000Z");

const repositories = [
  "scotty-dev/scotty",
  "scotty-dev/perseus",
  "scotty-dev/marvin",
  "scotty-dev/webby",
] as const;

const none: SessionCapabilities = {
  checkpoint: false,
  sleep: false,
  resume: false,
  work: false,
  vaporize: false,
};

const capabilitiesFor = (authority: SessionAuthority): SessionCapabilities => {
  if (authority.kind === "transitioning" || authority.lifecycle === "gone") return none;
  if (authority.lifecycle === "warm")
    return { checkpoint: true, sleep: true, resume: false, work: true, vaporize: true };
  if (authority.lifecycle === "sleeping") return { ...none, resume: true, vaporize: true };
  return {
    ...none,
    resume: authority.failure?.recoverable === true,
    vaporize: true,
  };
};

interface SessionInput {
  readonly id: string;
  readonly title: string;
  readonly authority: SessionAuthority;
  readonly repository?: string;
  readonly capRemainingSeconds?: number;
  readonly tombstone?: boolean;
}

const session = (input: SessionInput): SessionModel => ({
  id: input.id,
  authority: input.authority,
  runtime: {
    provider: "cloudflare",
    readiness:
      input.authority.kind === "stable" && input.authority.lifecycle === "warm"
        ? "unchecked"
        : "not-applicable",
  },
  capabilities: capabilitiesFor(input.authority),
  display: {
    title: input.title,
    repository: input.repository ?? repositories[0],
    branch: input.tombstone === true ? null : `scotty/${input.id}`,
    defaultBranch: input.tombstone === true ? null : "main",
  },
  times: { capRemainingSeconds: input.capRemainingSeconds ?? 3_300 },
  source: "fixture",
});

const stable = (
  lifecycle: SessionLifecycle,
  failure: { readonly code: string; readonly recoverable: boolean } | null = null,
): SessionAuthority => ({ kind: "stable", lifecycle, failure });

const transition = (
  action: SessionTransitionAction,
  phase: string,
  origin: "absent" | SessionLifecycle,
  mode: "executing" | "reconciling" = "executing",
  minutesAgo = 12,
): SessionAuthority => ({
  kind: "transitioning",
  action,
  phase,
  origin,
  mode,
  startedAt: new Date(FIXTURE_NOW.getTime() - minutesAgo * 60_000).toISOString(),
});

export const warmIdle = session({
  id: "warm-idle-001",
  title: "Tighten session lifecycle boundaries",
  authority: stable("warm"),
});

export const warmWorking = session({
  id: "warm-working-001",
  title: "Streaming the TanStack Start rebuild",
  authority: stable("warm"),
});

export const sleepingRetained = session({
  id: "sleeping-retained-001",
  title: "Review the safe-sleep transition",
  authority: stable("sleeping"),
});

export const failedRecoverable = session({
  id: "failed-recoverable-001",
  title: "Recover the interrupted workspace",
  authority: stable("failed", { code: "runtime_missing", recoverable: true }),
});

export const failedTerminal = session({
  id: "failed-terminal-001",
  title: "Session without a wake source",
  authority: stable("failed", { code: "backup_missing", recoverable: false }),
});

export const transitionCreate = session({
  id: "transition-create-001",
  title: "Preparing a new cloud workspace",
  authority: transition("create", "WorkspacePreparing", "absent"),
});

export const transitionSleep = session({
  id: "transition-sleep-001",
  title: "Preserving work before sleep",
  authority: transition("sleep", "Syncing", "warm", "reconciling"),
});

export const transitionResume = session({
  id: "transition-resume-001",
  title: "Restoring the retained workspace",
  authority: transition("resume", "BackupRestoring", "sleeping"),
});

export const transitionVaporize = session({
  id: "transition-vaporize-001",
  title: "Vaporizing a completed experiment",
  authority: transition("vaporize", "EvidenceInterrupting", "sleeping", "reconciling"),
});

export const goneTombstone = session({
  id: "gone-tombstone-001",
  title: "Completed lifecycle canary",
  authority: stable("gone"),
  tombstone: true,
});

export const projectionStale = {
  projected: session({
    id: "projection-stale-001",
    title: "Actor authority wins over the rail",
    authority: stable("warm"),
  }),
  actor: session({
    id: "projection-stale-001",
    title: "Actor authority wins over the rail",
    authority: stable("sleeping"),
  }),
} as const;

export const runtimeMissing = session({
  id: "runtime-missing-001",
  title: "Runtime readiness is being checked",
  authority: stable("warm"),
});

const transitionSeeds = [
  ["create", "WorkspacePreparing", "absent", "executing"],
  ["checkpoint", "BackupPrepared", "warm", "executing"],
  ["sleep", "Syncing", "warm", "reconciling"],
  ["resume", "BackupRestoring", "sleeping", "executing"],
  ["work", "RuntimeStarting", "warm", "executing"],
  ["evidence", "Running", "warm", "executing"],
  ["hatch", "Settling", "warm", "reconciling"],
  ["down", "Admitted", "warm", "executing"],
  ["vaporize", "EvidenceInterrupting", "sleeping", "reconciling"],
] as const;

const manySession = (index: number): SessionModel => {
  const suffix = String(index + 1).padStart(3, "0");
  const repository = repositories[index % repositories.length] ?? repositories[0];
  const title =
    index % 11 === 0
      ? "Investigate lifecycle behavior when a deliberately very long session title wraps across the rail"
      : index % 7 === 0
        ? "Untitled investigation"
        : `Workshop session ${suffix}`;
  const seed = transitionSeeds[index];
  if (seed !== undefined)
    return session({
      id: `many-session-${suffix}`,
      title,
      repository,
      authority: transition(seed[0], seed[1], seed[2], seed[3], 12 + index),
    });

  const stableIndex = index % 5;
  const authority =
    stableIndex === 0
      ? stable("warm")
      : stableIndex === 1
        ? stable("sleeping")
        : stableIndex === 2
          ? stable("failed", { code: "runtime_missing", recoverable: true })
          : stableIndex === 3
            ? stable("failed", { code: "backup_missing", recoverable: false })
            : stable("gone");
  return session({
    id: `many-session-${suffix}`,
    title,
    repository,
    authority,
    tombstone: stableIndex === 4,
  });
};

export const manySessions: ReadonlyArray<SessionModel> = Array.from({ length: 60 }, (_, index) =>
  manySession(index),
);

export const archivedSessionIds: ReadonlySet<string> = new Set(
  manySessions
    .slice(32)
    .filter(
      (fixture) =>
        fixture.authority.kind === "stable" &&
        (fixture.authority.lifecycle === "sleeping" || fixture.authority.lifecycle === "failed"),
    )
    .map((fixture) => fixture.id),
);

export interface HomeFixture {
  readonly id: "empty-installation" | "many-sessions" | "projection-stale";
  readonly projections: ReadonlyArray<SessionModel>;
  readonly selectedActorRead?: SessionModel;
}

export const homeFixtures: ReadonlyArray<HomeFixture> = [
  { id: "empty-installation", projections: [] },
  { id: "many-sessions", projections: manySessions },
  {
    id: "projection-stale",
    projections: [projectionStale.projected],
    selectedActorRead: projectionStale.actor,
  },
];

export const sidebarSessions: ReadonlyArray<SessionModel> = [
  warmWorking,
  warmIdle,
  sleepingRetained,
  failedRecoverable,
  failedTerminal,
  transitionCreate,
  transitionSleep,
  transitionResume,
  transitionVaporize,
  goneTombstone,
];

const sessionFixturesById = new Map(
  [...sidebarSessions, ...manySessions, projectionStale.actor].map((fixture) => [
    fixture.id,
    fixture,
  ]),
);

export const sessionFixtureForId = (sessionId: string): SessionModel | undefined =>
  sessionFixturesById.get(sessionId);
