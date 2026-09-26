import { isDeepStrictEqual } from "node:util";
import { assert, it } from "@effect/vitest";
import { Match, Predicate, Schema } from "effect";
import type {
  BackupProof,
  SessionAuthority,
  Transition,
  VaporizeAbsenceCategory,
} from "../../src/session-actor/reducer/authority";
import {
  AuthorityStateSchema,
  TransitionSchema,
  VaporizeAbsenceCategorySchema,
} from "../../src/session-actor/reducer/authority";
import type { SessionActorInput, TransitionProof } from "../../src/session-actor/reducer/input";
import { decide } from "../../src/session-actor/reducer/decide";
import {
  phaseIndex,
  transitionKind,
  transitionPhases,
} from "../../src/session-actor/reducer/transition";
import { runtimeProof } from "../../src/session-actor/reducer/control";
import { sessionIdentityPin } from "../runtime-cli/fixtures";
import { generateTraces, normalizeItf } from "../support/quint";

const actions = [
  "init",
  "createCommand",
  "checkpointCommand",
  "sleepCommand",
  "resumeCommand",
  "warmWorkCommand",
  "vaporizeCommand",
  "advance",
  "complete",
  "completeEarly",
  "unsafeSleepComplete",
  "incompleteVaporizeComplete",
  "deadline",
  "providerFailure",
  "unknownOutcome",
  "restart",
  "availabilityLost",
  "settleStoppedSleep",
  "hardCapElapsed",
  "redeliver",
] as const;
const Fence = Schema.Struct({
  revision: Schema.Int,
  kind: Schema.String,
  nonce: Schema.Int,
  attempt: Schema.Int,
  phase: Schema.Int,
});
const pick = <A extends Schema.Top>(item: A) =>
  Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("Some"), value: item }),
    Schema.Struct({ _tag: Schema.Literal("None") }),
  ]);
const Auth = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Absent") }),
  Schema.Struct({
    _tag: Schema.Literal("Stable"),
    value: Schema.Struct({
      kind: Schema.Literals(["Warm", "Sleeping", "Failed", "Gone"]),
      backup: Schema.Boolean,
      lastStable: Schema.Literals(["Warm", "Sleeping", "None"]),
      recovery: Schema.String,
      ownedBackups: Schema.Boolean,
      createInput: Schema.Boolean,
    }),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Transitioning"),
    value: Schema.Struct({
      kind: Schema.Literals(["Create", "Checkpoint", "Sleep", "Resume", "WarmWork", "Vaporize"]),
      phase: Schema.Int,
      mode: Schema.Literals(["Executing", "Reconciling"]),
      origin: Schema.Literals(["Absent", "Warm", "Sleeping", "Failed", "Gone"]),
      nonce: Schema.Int,
      attempt: Schema.Int,
      backup: Schema.Boolean,
      lastStable: Schema.Literals(["Warm", "Sleeping", "None"]),
    }),
  }),
]);
const Outcome = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Init") }),
  Schema.Struct({ _tag: Schema.Literal("Accepted") }),
  Schema.Struct({ _tag: Schema.Literal("Rejected"), value: Schema.String }),
]);
const decodeAuth = Schema.decodeUnknownSync(Auth);
const State = Schema.Struct({
  auth: Auth,
  revision: Schema.Int,
  nonceSeq: Schema.Int,
  hardCapGeneration: Schema.Int,
  scenarioOutcome: Schema.String,
  cell: Schema.Struct({
    kind: Schema.String,
    outcome: Schema.String,
    reason: Schema.String,
    lease: Schema.String,
  }),
  outcome: Outcome,
  issued: Schema.Array(Fence),
  lastAction: Schema.Literals(actions),
  "mbt::actionTaken": Schema.Union([
    Schema.Literals(actions),
    Schema.Literals(["step", "guidedStep"]),
  ]),
  "mbt::nondetPicks": Schema.Struct({
    staleRevision: pick(Schema.Boolean),
    early: pick(Schema.Boolean),
    due: pick(Schema.Boolean),
    reconcileFence: pick(Schema.Boolean),
    reconcileResult: pick(Schema.Literals(["progress", "complete", "failure", "unknown"])),
    invalidCase: pick(Schema.Boolean),
    missingCategory: pick(VaporizeAbsenceCategorySchema),
    fence: pick(Fence),
  }),
});
type ModelState = typeof State.Type;
type ReplayAction = (typeof actions)[number];
const decodeTrace = Schema.decodeUnknownSync(Schema.Struct({ states: Schema.Array(State) }));
const backupSummary = (proof: BackupProof) => ({
  backup: hasBackup(proof),
  lastStable: "Warm",
  ownedBackups: proof.ownedBackupIds.length > 0,
});
const transitionBackup = (proof: BackupProof) => ({ backup: hasBackup(proof), lastStable: "Warm" });
const abstractAuthority = (
  authority: SessionAuthority | undefined,
): { ok: true; auth: typeof Auth.Type } | { ok: false; message: string } => {
  if (authority === undefined) return { ok: true, auth: decodeAuth({ _tag: "Absent" }) };
  if (AuthorityStateSchema.guards.Stable(authority.state)) {
    const stable = authority.state.stable;
    const value = Match.valueTags(stable, {
      Warm: (warm) => ({
        kind: "Warm",
        ...backupSummary(warm.backups),
        recovery: "",
        createInput: false,
      }),
      Sleeping: (sleeping) => ({
        kind: "Sleeping",
        recovery: "",
        lastStable: "Sleeping",
        backup:
          sleeping.backup.confirmedAt !== null &&
          sleeping.ownedBackupIds.includes(sleeping.backup.backupId),
        ownedBackups: sleeping.ownedBackupIds.length > 0,
        createInput: false,
      }),
      Failed: (failed) => ({
        kind: "Failed",
        recovery: Match.valueTags(failed.recovery, {
          Resume: () => "Resume",
          Create: () => "Create",
          Terminal: () => "Terminal",
        }),
        lastStable: failed.lastStable === null ? "None" : failed.lastStable,
        backup:
          Predicate.isTagged(failed.recovery, "Resume") &&
          failed.recovery.backup.confirmedAt !== null &&
          failed.ownedBackupIds.includes(failed.recovery.backup.backupId),
        ownedBackups: failed.ownedBackupIds.length > 0,
        createInput: Predicate.isTagged(failed.recovery, "Create"),
      }),
      Gone: (gone) => ({
        kind: "Gone",
        backup: false,
        lastStable: "None",
        recovery: "",
        ownedBackups: !gone.cleanup.absent.includes("backups"),
        createInput: false,
      }),
    });
    return { ok: true, auth: decodeAuth({ _tag: "Stable", value }) };
  }
  const transition = authority.state.transition;
  const nonce = modelId("nonce", transition.nonce);
  const attempt = modelId("attempt", transition.attempt);
  if (nonce === undefined || attempt === undefined)
    return { ok: false, message: `unparsable lease identity: ${JSON.stringify(transition)}` };
  const proof = Match.valueTags(transition, {
    Create: () => ({ backup: false, lastStable: "None" }),
    Checkpoint: (checkpoint) => transitionBackup(checkpoint.proof.backup),
    Sleep: (sleep) => transitionBackup(sleep.proof.backup),
    Resume: (resume) => ({
      backup:
        resume.proof.backup.confirmedAt !== null &&
        resume.proof.ownedBackupIds.includes(resume.proof.backup.backupId),
      lastStable: resume.proof.lastStable,
    }),
    WarmWork: (work) => transitionBackup(work.proof.backups),
    Vaporize: () => ({ backup: false, lastStable: "None" }),
  });
  return {
    ok: true,
    auth: decodeAuth({
      _tag: "Transitioning",
      value: {
        kind: transitionKind(transition),
        phase: phaseIndex(transition),
        mode: transition.mode === "executing" ? "Executing" : "Reconciling",
        origin: transition.origin,
        nonce,
        attempt,
        ...proof,
      },
    }),
  };
};

type ReplayResult = { ok: true } | { ok: false; step: number; message: string };
const hardCapFor = (timestamp: string, sequence: number) => ({
  durationSeconds: 3_600,
  deadlineAt: new Date(Date.parse(timestamp) + 3_600_000).toISOString(),
  generation: `hard-cap-${sequence}`,
});
const session: SessionAuthority["session"] = {
  id: "session-1",
  title: "Session one",
  repository: "owner/repository",
  execution: { provider: "cloudflare", runtimeName: "runtime-name" },
  ...sessionIdentityPin,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const readiness = {
  runtime: {
    providerRuntimeId: "provider-runtime-1",
    runtimeGeneration: "runtime-1",
    containerIncarnation: "container-1",
  },
  supervisor: {
    processId: "pi-1",
    supervisorEpoch: "supervisor-1",
    runtimeGeneration: "runtime-1",
    containerIncarnation: "container-1",
  },
  transport: {
    transportId: "transport-1",
    supervisorEpoch: "supervisor-1",
    runtimeGeneration: "runtime-1",
    containerIncarnation: "container-1",
  },
};
const backupIdentity = (timestamp: string, confirmed: boolean) => ({
  backupId: "backup-1",
  preparedAt: timestamp,
  confirmedAt: confirmed ? timestamp : null,
  sourceRuntimeGeneration: readiness.runtime.runtimeGeneration,
});
const backupFor = (proof: BackupProof, nextIndex: number, timestamp: string): BackupProof => {
  if (proof.currentBackupId !== null) return proof;
  if (nextIndex < 3) return proof;
  const prepared = proof.prepared === null ? backupIdentity(timestamp, false) : proof.prepared;
  if (nextIndex < 4)
    return { ownedBackupIds: [prepared.backupId], prepared, currentBackupId: null };
  const confirmed = { ...prepared, confirmedAt: timestamp };
  return {
    ownedBackupIds: [confirmed.backupId],
    prepared: confirmed,
    confirmed,
    currentBackupId: confirmed.backupId,
  };
};
const hasBackup = (proof: BackupProof): boolean => {
  const confirmed = proof.confirmed || proof.prepared;
  return (
    confirmed !== null &&
    confirmed.confirmedAt !== null &&
    confirmed.backupId === proof.currentBackupId &&
    proof.ownedBackupIds.includes(confirmed.backupId)
  );
};
const absence: ReadonlyArray<VaporizeAbsenceCategory> = VaporizeAbsenceCategorySchema.literals;
const modelFenceKey = (r: number, k: string, n: number, p: number) => `${r}:${k}:${n}:${p}`;
const modelId = (prefix: "nonce" | "attempt", value: string): number | undefined => {
  const label = `${prefix}-`;
  const digits = value.startsWith(label) ? value.slice(label.length) : "";
  const number = /^\d+$/.test(digits) ? Number(digits) : NaN;
  return Number.isSafeInteger(number) ? number : undefined;
};
const inputFailure = (context: StepContext, message: string): ReplayResult => ({
  ok: false,
  step: context.step,
  message: `${message}; trace=${JSON.stringify(context.previous)}`,
});
const picked = <A>(value: { _tag: "Some"; value: A } | { _tag: "None" }): A | undefined =>
  Predicate.isTagged(value, "Some") ? value.value : undefined;

const sleepProofFor = (
  transition: Extract<Transition, { _tag: "Sleep" }>,
  nextIndex: number,
  timestamp: string,
): TransitionProof => {
  const stopRequestedAt =
    nextIndex >= 5
      ? transition.proof.stopRequestedAt === null || transition.proof.stopRequestedAt === undefined
        ? timestamp
        : transition.proof.stopRequestedAt
      : null;
  return {
    ...transition.proof,
    piStoppedAt: nextIndex >= 1 ? timestamp : transition.proof.piStoppedAt,
    backup: backupFor(transition.proof.backup, nextIndex, timestamp),
    stopRequestedAt,
    stop:
      nextIndex >= 6 && stopRequestedAt !== null
        ? {
            requestedAt: stopRequestedAt,
            observedAt: timestamp,
            runtimeGeneration: readiness.runtime.runtimeGeneration,
          }
        : null,
  };
};

const proofFor = (
  transition: Transition,
  nextIndex: number,
  timestamp: string,
): TransitionProof => {
  if (TransitionSchema.guards.Create(transition))
    return {
      workspaceId: nextIndex >= 2 ? "workspace-1" : transition.proof.workspaceId,
      readiness: {
        runtime: nextIndex >= 4 ? readiness.runtime : transition.proof.readiness.runtime,
        supervisor: nextIndex >= 7 ? readiness.supervisor : transition.proof.readiness.supervisor,
        transport: nextIndex >= 7 ? readiness.transport : transition.proof.readiness.transport,
      },
    };
  if (TransitionSchema.guards.Checkpoint(transition))
    return {
      ...transition.proof,
      piStoppedAt: nextIndex >= 1 ? timestamp : transition.proof.piStoppedAt,
      backup: backupFor(transition.proof.backup, nextIndex, timestamp),
    };
  if (TransitionSchema.guards.Sleep(transition))
    return sleepProofFor(transition, nextIndex, timestamp);
  if (TransitionSchema.guards.Resume(transition))
    return {
      ...transition.proof,
      readiness: {
        runtime: nextIndex >= 2 ? readiness.runtime : transition.proof.readiness.runtime,
        supervisor: nextIndex >= 4 ? readiness.supervisor : transition.proof.readiness.supervisor,
        transport: nextIndex >= 5 ? readiness.transport : transition.proof.readiness.transport,
      },
    };
  if (TransitionSchema.guards.WarmWork(transition))
    return { ...transition.proof, resultCode: nextIndex >= 2 ? "ok" : transition.proof.resultCode };
  return {
    revokedAt: nextIndex >= 1 ? timestamp : null,
    ownedBackupIds: nextIndex >= 5 ? [] : transition.proof.ownedBackupIds,
    cleanup: {
      absent: vaporizeAbsent(nextIndex),
      lastObservedAt: timestamp,
    },
  };
};
const vaporizeAbsent = (index: number): Array<VaporizeAbsenceCategory> => {
  const absent: Array<VaporizeAbsenceCategory> = [];
  if (index >= 2) absent.push("hatch");
  if (index >= 4) absent.push("runtime");
  if (index >= 5) absent.push("backups");
  if (index >= 6) absent.push("evidence");
  if (index >= 7) absent.push("grants", "idempotency");
  if (index >= 8) absent.push("schedules");
  return absent;
};
type StepContext = {
  authority: SessionAuthority | undefined;
  current: Transition | undefined;
  previous: ModelState;
  picks: ModelState["mbt::nondetPicks"];
  timestamp: string;
  correlationId: string;
  step: number;
  committed: Map<string, { revision: number; transition: Transition }>;
  advanceClock: (deadline: number) => void;
};

const commandFields = (context: StepContext) => ({
  expectedRevision:
    (context.authority === undefined ? 0 : context.authority.revision) +
    (picked(context.picks.staleRevision) ? 1 : 0),
  nonce: `nonce-${context.previous.nonceSeq}`,
  attempt: `attempt-${context.previous.nonceSeq}`,
  timestamp: context.timestamp,
  correlationId: context.correlationId,
  deadlineAt: new Date(Date.parse(context.timestamp) + 3_600_000).toISOString(),
});

const factFields = (context: StepContext, revision: number, transition: Transition) => ({
  revision,
  transitionNonce: transition.nonce,
  attempt: transition.attempt,
  expectedPhase: transition.phase,
  timestamp: context.timestamp,
  correlationId: context.correlationId,
});

const withCurrent = (
  context: StepContext,
  build: (
    context: StepContext & { authority: SessionAuthority; current: Transition },
  ) => SessionActorInput | ReplayResult,
): SessionActorInput | ReplayResult =>
  context.current !== undefined && context.authority !== undefined
    ? build({ ...context, current: context.current, authority: context.authority })
    : inputFailure(context, "action requires an active lease");

const progressInput = (context: StepContext, restart: boolean): SessionActorInput | ReplayResult =>
  withCurrent(context, (active) => {
    const nextIndex = phaseIndex(active.current) + 1;
    const nextPhase = transitionPhases(active.current)[nextIndex];
    if (nextPhase === undefined) return inputFailure(active, "progress has no next phase");
    const proof = proofFor(active.current, nextIndex, active.timestamp);
    const fields = factFields(active, active.authority.revision, active.current);
    if (!restart || TransitionSchema.guards.WarmWork(active.current))
      return { _tag: "ActorFact", ...fields, nextPhase, proof, resultCode: "ok" };
    const runtime = runtimeProof(active.current);
    return {
      _tag: "ProviderObservation",
      ...fields,
      nextPhase,
      proof,
      expectedProviderRuntimeId: runtime === null ? null : runtime.providerRuntimeId,
      resultCode: "ok",
    };
  });

const unknownInput = (context: StepContext, restart: boolean): SessionActorInput | ReplayResult =>
  withCurrent(context, (active) => {
    const runtime = runtimeProof(active.current);
    return {
      _tag: "UnknownProviderOutcome",
      ...factFields(active, active.authority.revision, active.current),
      expectedProviderRuntimeId: restart && runtime !== null ? runtime.providerRuntimeId : null,
      resultCode: restart ? "actor_restart_reconcile" : "outcome_unknown",
    };
  });

const completedInput = (context: StepContext): SessionActorInput | ReplayResult =>
  withCurrent(context, (active) => ({
    _tag: "TransitionCompleted",
    ...factFields(active, active.authority.revision, active.current),
    proof: active.current.proof,
    resultCode: "completed",
  }));

const inputs: {
  [K in Exclude<ReplayAction, "init">]: (context: StepContext) => SessionActorInput | ReplayResult;
} = {
  createCommand: (context) => ({
    _tag: "CreateCommand",
    ...commandFields(context),
    session,
    hardCap: hardCapFor(context.timestamp, context.previous.nonceSeq + 1),
  }),
  checkpointCommand: (context) => ({ _tag: "CheckpointCommand", ...commandFields(context) }),
  sleepCommand: (context) => ({ _tag: "SleepCommand", ...commandFields(context) }),
  resumeCommand: (context) => ({
    _tag: "ResumeCommand",
    ...commandFields(context),
    nextHardCap: hardCapFor(context.timestamp, context.previous.nonceSeq + 1),
  }),
  warmWorkCommand: (context) => ({
    _tag: "WarmWorkCommand",
    ...commandFields(context),
    workKind: "Evidence",
  }),
  vaporizeCommand: (context) => ({ _tag: "VaporizeCommand", ...commandFields(context) }),
  redeliver: (context) => {
    const fence = picked(context.picks.fence);
    const snapshot =
      fence === undefined
        ? undefined
        : context.committed.get(
            modelFenceKey(fence.revision, fence.kind, fence.nonce, fence.phase),
          );
    if (snapshot === undefined) return inputFailure(context, "redelivery has no committed fence");
    const transition = snapshot.transition;
    const fields = factFields(context, snapshot.revision, transition);
    const nextPhase = transitionPhases(transition)[phaseIndex(transition) + 1];
    if (nextPhase === undefined) return inputFailure(context, "redelivery has no next phase");
    return {
      _tag: "ActorFact",
      ...fields,
      nextPhase,
      proof: transition.proof,
      resultCode: "ok",
    };
  },
  advance: (context) => progressInput(context, false),
  complete: completedInput,
  completeEarly: completedInput,
  unsafeSleepComplete: (context) =>
    withCurrent(context, (active) => {
      if (!TransitionSchema.guards.Sleep(active.current))
        return inputFailure(active, "expected Sleep lease");
      const proof = active.current.proof;
      const prepared = proof.backup.prepared;
      if (prepared === null) return inputFailure(active, "Sleep backup is unprepared");
      const invalidCase = picked(active.picks.invalidCase);
      if (invalidCase === undefined) return inputFailure(active, "missing Sleep invalid case pick");
      return {
        _tag: "TransitionCompleted",
        ...factFields(active, active.authority.revision, active.current),
        proof: invalidCase
          ? { ...proof, backup: { ...proof.backup, prepared: { ...prepared, confirmedAt: null } } }
          : { ...proof, stop: null },
        resultCode: invalidCase ? "invalid_backup" : "missing_stop",
      };
    }),
  incompleteVaporizeComplete: (context) =>
    withCurrent(context, (active) => {
      if (!TransitionSchema.guards.Vaporize(active.current))
        return inputFailure(active, "expected Vaporize lease");
      const missing = picked(active.picks.missingCategory);
      if (missing === undefined) return inputFailure(active, "missing Vaporize category pick");
      return {
        _tag: "TransitionCompleted",
        ...factFields(active, active.authority.revision, active.current),
        proof: {
          ...active.current.proof,
          cleanup: {
            absent: absence.filter((category) => category !== missing),
            lastObservedAt: active.timestamp,
          },
        },
        resultCode: "incomplete_cleanup",
      };
    }),
  deadline: (context) =>
    withCurrent(context, (active) => {
      const deadline = Date.parse(active.current.deadlineAt);
      const choice = picked(active.picks.early);
      if (choice === undefined && active.previous.scenarioOutcome !== "deadline")
        return inputFailure(active, "missing deadline timing pick");
      const early = choice === true;
      if (!early) active.advanceClock(deadline);
      return {
        _tag: "DeadlineAlarm",
        ...factFields(active, active.authority.revision, active.current),
        timestamp: new Date(early ? deadline - 1 : deadline).toISOString(),
        expectedDeadlineAt: active.current.deadlineAt,
        alarmId: `alarm-${active.step}`,
      };
    }),
  providerFailure: (context) =>
    withCurrent(context, (active) => ({
      _tag: "TransitionFailed",
      ...factFields(active, active.authority.revision, active.current),
      failureCode: "provider_failed",
      ownedBackupIds: [],
      resultCode: "provider_failed",
    })),
  unknownOutcome: (context) => unknownInput(context, false),
  restart: (context) => {
    const skipDeadline =
      context.current !== undefined &&
      TransitionSchema.guards.Vaporize(context.current) &&
      context.current.mode === "reconciling" &&
      picked(context.picks.reconcileFence) === true;
    if (picked(context.picks.due) === true && !skipDeadline)
      return inputs.deadline({
        ...context,
        picks: { ...context.picks, early: { _tag: "Some", value: false } },
      });
    if (context.current?.mode === "executing") return unknownInput(context, true);
    const observed = picked(context.picks.reconcileResult);
    if (observed === "progress") return progressInput(context, true);
    if (observed === "complete") return inputs.complete(context);
    if (observed === "failure") return inputs.providerFailure(context);
    return unknownInput(context, true);
  },
  availabilityLost: (context) => ({
    _tag: "SupervisorUnavailableObserved",
    expectedRuntimeGeneration: readiness.runtime.runtimeGeneration,
    expectedSupervisorEpoch: readiness.supervisor.supervisorEpoch,
    correlationId: context.correlationId,
    timestamp: context.timestamp,
    resultCode: "supervisor_unavailable",
  }),
  settleStoppedSleep: (context) =>
    withCurrent(context, (active) => ({
      _tag: "RuntimeLifecycleObserved",
      expectedProviderRuntimeId: readiness.runtime.providerRuntimeId,
      expectedRuntimeGeneration: readiness.runtime.runtimeGeneration,
      lifecycle: "stopped",
      runtime: null,
      correlationId: active.correlationId,
      timestamp: active.timestamp,
      resultCode: "runtime_stopped",
    })),
  hardCapElapsed: (context) => {
    const currentCap =
      context.authority === undefined
        ? hardCapFor(context.timestamp, 0)
        : context.authority.hardCap;
    const deadline = Date.parse(currentCap.deadlineAt);
    context.advanceClock(deadline);
    return {
      _tag: "HardCapDeadlineAlarm",
      alarmId: `hard-cap-${context.step}`,
      expectedGeneration: currentCap.generation,
      expectedDeadlineAt: currentCap.deadlineAt,
      correlationId: context.correlationId,
      timestamp: new Date(Math.max(Date.parse(context.timestamp), deadline)).toISOString(),
    };
  },
};

const matches = (
  expected: ModelState,
  auth: typeof Auth.Type,
  outcome: unknown,
  authority: SessionAuthority | undefined,
): boolean =>
  isDeepStrictEqual(outcome, expected.outcome) &&
  (authority === undefined ? 0 : authority.revision) === expected.revision &&
  (authority === undefined
    ? expected.hardCapGeneration === 0
    : authority.hardCap.generation === `hard-cap-${expected.hardCapGeneration}`) &&
  isDeepStrictEqual(auth, expected.auth);

const stuttered = (before: ModelState, after: ModelState): boolean =>
  after.cell.kind === "" &&
  isDeepStrictEqual(after.auth, before.auth) &&
  after.revision === before.revision &&
  isDeepStrictEqual(after.outcome, before.outcome) &&
  after.lastAction === before.lastAction &&
  after["mbt::actionTaken"] === "guidedStep";

const replay = (states: ReadonlyArray<ModelState>): ReplayResult => {
  let authority: SessionAuthority | undefined;
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const committed = new Map<string, { revision: number; transition: Transition }>();
  for (let step = 1; step < states.length; step++) {
    const previous = states[step - 1];
    const expected = states[step];
    if (previous === undefined || expected === undefined)
      return { ok: false, step, message: "trace state is missing" };
    clock += 1_000;
    const action = expected.lastAction;
    const current =
      authority !== undefined && AuthorityStateSchema.guards.Transitioning(authority.state)
        ? authority.state.transition
        : undefined;
    const context: StepContext = {
      authority,
      current,
      previous,
      picks: expected["mbt::nondetPicks"],
      timestamp: new Date(clock).toISOString(),
      correlationId: `replay-${step}`,
      step,
      committed,
      advanceClock: (deadline) => {
        clock = Math.max(clock, deadline);
      },
    };
    if (stuttered(previous, expected)) continue;
    if (action.endsWith("Command") && picked(context.picks.staleRevision) === undefined)
      return inputFailure(context, "command is missing its revision pick");
    const input = action === "init" ? undefined : inputs[action](context);
    if (input === undefined) return inputFailure(context, `cannot map ${action}`);
    if ("ok" in input) return input;
    const decision = decide(authority, input);
    if (Predicate.isTagged(decision, "Accepted")) {
      authority = decision.nextAuthority;
      if (AuthorityStateSchema.guards.Transitioning(authority.state)) {
        const transition = authority.state.transition;
        const nonce = modelId("nonce", transition.nonce);
        if (nonce === undefined) return inputFailure(context, "committed nonce is unparsable");
        committed.set(
          modelFenceKey(
            authority.revision,
            transitionKind(transition),
            nonce,
            phaseIndex(transition),
          ),
          { revision: authority.revision, transition },
        );
      }
    }
    const actualOutcome = Predicate.isTagged(decision, "Accepted")
      ? { _tag: "Accepted" }
      : { _tag: "Rejected", value: decision.code };
    const abstraction = abstractAuthority(authority);
    if (!abstraction.ok) return { ok: false, step, message: abstraction.message };
    const actualAuth = abstraction.auth;
    if (!matches(expected, actualAuth, actualOutcome, authority))
      return {
        ok: false,
        step,
        message: `action=${action} input=${JSON.stringify(input)} decision=${JSON.stringify(decision)} expected=${JSON.stringify({ outcome: expected.outcome, revision: expected.revision, auth: expected.auth })} actual=${JSON.stringify({ outcome: actualOutcome, revision: authority === undefined ? 0 : authority.revision, auth: actualAuth })}`,
      };
  }
  return { ok: true };
};

const sampled = (): ReadonlyArray<ReadonlyArray<ModelState>> =>
  generateTraces({
    model: "spec/quint/session_lease.qnt",
    seed: "0x5c077",
    traces: 300,
    step: "guidedStep",
    maxSteps: 80,
  }).map((trace) => decodeTrace(normalizeItf(trace)).states);

it("replays required lifecycle and fenced-input cells against the reducer", () => {
  const cells = new Set<string>();
  sampled().forEach((trace, index) => {
    trace.forEach((state) => {
      if (state.cell.kind !== "")
        cells.add(
          [state.cell.kind, state.cell.outcome, state.cell.reason, state.cell.lease]
            .filter(Boolean)
            .join(":"),
        );
    });
    const result = replay(trace);
    assert.ok(result.ok, `trace ${index}: ${result.ok ? "" : result.message}`);
  });
  const required = [
    "complete:Accepted:Gone",
    "complete:Accepted:Sleeping",
    "settleStoppedSleep:Accepted:Sleeping",
    "resumeCommand:Accepted:Failed",
    "createCommand:Accepted:Failed",
    "availabilityLost:Accepted:Executing",
    "availabilityLost:Rejected:duplicate:Reconciling",
    "completeEarly:Rejected",
    "restart:VaporizeReconcileFence:observation",
    "restart:DueFence:deadline",
    "restart:Executing:unknown",
    "restart:Reconciling:observation",
    "unsafeSleepComplete:Rejected:backup",
    "unsafeSleepComplete:Rejected:stop",
  ];
  for (const kind of ["Create", "Checkpoint", "Sleep", "Resume", "WarmWork"]) {
    for (const action of ["deadline", "providerFailure", "hardCapElapsed"])
      required.push(`${action}:Accepted:${kind}`);
    required.push(`unknownOutcome:Accepted:Reconciling:${kind}`);
  }
  required.push("redeliver:Rejected");
  for (const category of absence) required.push(`incompleteVaporizeComplete:Rejected:${category}`);
  assert.deepStrictEqual(
    required.filter((cell) => !cells.has(cell)),
    [],
  );
}, 120_000);
