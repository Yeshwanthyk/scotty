import { isDeepStrictEqual } from "node:util";
import { sessionIdentityPin } from "../runtime-cli/fixtures";
import { assert, it } from "@effect/vitest";
import { Predicate, Schema } from "effect";
import type {
  SessionAuthority,
  Transition,
  VaporizeAbsenceCategory,
} from "../../src/session-actor/reducer/authority";
import {
  AuthorityStateSchema,
  StableStateSchema,
  TransitionSchema,
} from "../../src/session-actor/reducer/authority";
import type { SessionActorInput, TransitionProof } from "../../src/session-actor/reducer/input";
import { decide } from "../../src/session-actor/reducer/decide";
import { phaseIndex, transitionPhases } from "../../src/session-actor/reducer/transition";
import { generateTraces, normalizeItf } from "../support/quint";

const actions = [
  "init",
  "createCommand",
  "vaporizeCommand",
  "advance",
  "complete",
  "completeEarly",
  "deadline",
  "providerFailure",
  "redeliver",
] as const;
const Fence = Schema.Struct({
  revision: Schema.Int,
  kind: Schema.String,
  nonce: Schema.Int,
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
    value: Schema.Literals(["Warm", "Failed", "Gone"]),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Transitioning"),
    value: Schema.Struct({
      kind: Schema.Literals(["Create", "Vaporize"]),
      phase: Schema.Int,
      mode: Schema.Literals(["Executing", "Reconciling"]),
      origin: Schema.Literals(["Absent", "Warm", "Failed", "Gone"]),
      nonce: Schema.Int,
    }),
  }),
]);
const Outcome = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Init") }),
  Schema.Struct({ _tag: Schema.Literal("Accepted") }),
  Schema.Struct({ _tag: Schema.Literal("Rejected"), value: Schema.String }),
]);
const State = Schema.Struct({
  auth: Auth,
  revision: Schema.Int,
  nonceSeq: Schema.Int,
  outcome: Outcome,
  issued: Schema.Array(Fence),
  "mbt::actionTaken": Schema.Literals(actions),
  "mbt::nondetPicks": Schema.Struct({
    staleRevision: pick(Schema.Boolean),
    early: pick(Schema.Boolean),
    fence: pick(Fence),
    roll: pick(Schema.Int),
  }),
});
const Trace = Schema.Struct({ states: Schema.Array(State) });
type ModelState = typeof State.Type;
const decodeTrace = Schema.decodeUnknownSync(Trace);
const hardCap = {
  durationSeconds: 3_600,
  deadlineAt: "2030-01-01T00:00:00.000Z",
  generation: "hard-cap-1",
};
const session = {
  id: "session-1",
  title: "Session one",
  repository: "owner/repository",
  execution: { provider: "cloudflare" as const, runtimeName: "runtime-name" },
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
const absence: ReadonlyArray<VaporizeAbsenceCategory> = [
  "runtime",
  "backups",
  "evidence",
  "grants",
  "hatch",
  "idempotency",
  "schedules",
];
const modelFenceKey = (revision: number, kind: string, nonce: number, phase: number) =>
  `${revision}:${kind}:${nonce}:${phase}`;
const modelNonce = (transition: Transition): number | undefined => {
  const match = /^nonce-(\d+)$/.exec(transition.nonce);
  if (match === null) return undefined;
  const nonce = Number(match[1]);
  return Number.isSafeInteger(nonce) ? nonce : undefined;
};
const transitionKind = (transition: Transition): Transition["_tag"] => {
  if (TransitionSchema.guards.Create(transition)) return "Create";
  if (TransitionSchema.guards.Checkpoint(transition)) return "Checkpoint";
  if (TransitionSchema.guards.Sleep(transition)) return "Sleep";
  if (TransitionSchema.guards.Resume(transition)) return "Resume";
  if (TransitionSchema.guards.WarmWork(transition)) return "WarmWork";
  return "Vaporize";
};
const picked = <A>(value: { _tag: "Some"; value: A } | { _tag: "None" }): A | undefined =>
  Predicate.isTagged(value, "Some") ? value.value : undefined;

const proofFor = (
  transition: Transition,
  nextIndex: number,
  timestamp: string,
): TransitionProof => {
  if (TransitionSchema.guards.Create(transition))
    return {
      workspaceId: nextIndex >= 1 ? "workspace-1" : transition.proof.workspaceId,
      readiness: {
        runtime: nextIndex >= 3 ? readiness.runtime : transition.proof.readiness.runtime,
        supervisor: nextIndex >= 5 ? readiness.supervisor : transition.proof.readiness.supervisor,
        transport: nextIndex >= 6 ? readiness.transport : transition.proof.readiness.transport,
      },
    };
  if (TransitionSchema.guards.Vaporize(transition))
    return {
      revokedAt: nextIndex >= 1 ? (transition.proof.revokedAt ?? timestamp) : null,
      ownedBackupIds: transition.proof.ownedBackupIds,
      cleanup: {
        absent: nextIndex >= 8 ? absence.slice(0, 6) : absence.slice(0, Math.min(nextIndex, 6)),
        lastObservedAt: timestamp,
      },
    };
  return transition.proof;
};
const terminalProof = (transition: Transition, timestamp: string): TransitionProof => {
  if (TransitionSchema.guards.Create(transition))
    return {
      workspaceId: "workspace-1",
      readiness,
    };
  if (TransitionSchema.guards.Vaporize(transition))
    return {
      ...transition.proof,
      cleanup: { absent: [...absence], lastObservedAt: timestamp },
    };
  return transition.proof;
};

const abstractAuthority = (authority: SessionAuthority | undefined): unknown => {
  if (authority === undefined) return { _tag: "Absent" };
  if (AuthorityStateSchema.guards.Stable(authority.state)) {
    const stable = authority.state.stable;
    if (StableStateSchema.guards.Sleeping(stable))
      return { _tag: "UnexpectedStable", value: "Sleeping" };
    if (StableStateSchema.guards.Failed(stable))
      return stable.actionable
        ? { _tag: "UnexpectedStable", value: "Failed" }
        : { _tag: "Stable", value: "Failed" };
    return {
      _tag: "Stable",
      value: StableStateSchema.guards.Warm(stable) ? "Warm" : "Gone",
    };
  }
  const transition = authority.state.transition;
  const nonce = modelNonce(transition);
  if (nonce === undefined) return { _tag: "UnparsableNonce" };
  return {
    _tag: "Transitioning",
    value: {
      kind: transitionKind(transition),
      phase: phaseIndex(transition),
      mode: transition.mode === "executing" ? "Executing" : "Reconciling",
      origin: transition.origin,
      nonce,
    },
  };
};

type ReplayResult = { ok: true } | { ok: false; step: number; message: string };
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
    (context.authority?.revision ?? 0) + (picked(context.picks.staleRevision) ? 1 : 0),
  nonce: `nonce-${context.previous.nonceSeq}`,
  attempt: `attempt-${context.previous.nonceSeq}`,
  timestamp: context.timestamp,
  correlationId: context.correlationId,
  deadlineAt: new Date(Date.parse(context.timestamp) + 3_600_000).toISOString(),
});

const factFields = (
  context: StepContext & { authority: SessionAuthority; current: Transition },
) => ({
  revision: context.authority.revision,
  transitionNonce: context.current.nonce,
  attempt: context.current.attempt,
  expectedPhase: context.current.phase,
  timestamp: context.timestamp,
  correlationId: context.correlationId,
});

const withCurrent = (
  context: StepContext,
  build: (
    context: StepContext & { authority: SessionAuthority; current: Transition },
  ) => SessionActorInput,
): SessionActorInput | undefined =>
  context.current !== undefined && context.authority !== undefined
    ? build({ ...context, current: context.current, authority: context.authority })
    : undefined;

const inputs: {
  [K in Exclude<(typeof actions)[number], "init">]: (
    context: StepContext,
  ) => SessionActorInput | undefined;
} = {
  createCommand: (context) => ({
    _tag: "CreateCommand",
    ...commandFields(context),
    session,
    hardCap,
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
    if (snapshot === undefined) return undefined;
    const transition = snapshot.transition;
    return {
      _tag: "ActorFact",
      revision: snapshot.revision,
      transitionNonce: transition.nonce,
      attempt: transition.attempt,
      expectedPhase: transition.phase,
      timestamp: context.timestamp,
      correlationId: context.correlationId,
      nextPhase: transitionPhases(transition)[phaseIndex(transition) + 1] ?? transition.phase,
      proof: transition.proof,
      resultCode: "ok",
    };
  },
  advance: (context) =>
    withCurrent(context, (active) => {
      const nextIndex = phaseIndex(active.current) + 1;
      return {
        _tag: "ActorFact",
        ...factFields(active),
        nextPhase: transitionPhases(active.current)[nextIndex] ?? active.current.phase,
        proof: proofFor(active.current, nextIndex, active.timestamp),
        resultCode: "ok",
      };
    }),
  complete: (context) =>
    withCurrent(context, (active) => ({
      _tag: "TransitionCompleted",
      ...factFields(active),
      proof: terminalProof(active.current, active.timestamp),
      resultCode: "completed",
    })),
  completeEarly: (context) =>
    withCurrent(context, (active) => ({
      _tag: "TransitionCompleted",
      ...factFields(active),
      proof: active.current.proof,
      resultCode: "completed",
    })),
  deadline: (context) =>
    withCurrent(context, (active) => {
      const deadline = Date.parse(active.current.deadlineAt);
      const early = picked(active.picks.early) === true;
      if (!early) active.advanceClock(deadline);
      return {
        _tag: "DeadlineAlarm",
        ...factFields(active),
        timestamp: new Date(early ? deadline - 1 : deadline).toISOString(),
        expectedDeadlineAt: active.current.deadlineAt,
        alarmId: `alarm-${active.step}`,
      };
    }),
  providerFailure: (context) =>
    withCurrent(context, (active) => ({
      _tag: "TransitionFailed",
      ...factFields(active),
      failureCode: "provider_failed",
      actionable: false,
      backup: null,
      ownedBackupIds: [],
      wakeSource: null,
      resultCode: "provider_failed",
    })),
};

const replay = (states: ReadonlyArray<ModelState>): ReplayResult => {
  let authority: SessionAuthority | undefined;
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const committed = new Map<string, { revision: number; transition: Transition }>();
  for (let step = 1; step < states.length; step++) {
    const previous = states[step - 1];
    const expected = states[step];
    if (previous === undefined || expected === undefined) continue;
    clock += 1_000;
    const action = expected["mbt::actionTaken"];
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
    const input = action === "init" ? undefined : inputs[action](context);
    if (input === undefined)
      return {
        ok: false,
        step,
        message: `cannot map ${action}; model=${JSON.stringify(expected)}`,
      };
    const decision = decide(authority, input);
    if (Predicate.isTagged(decision, "Accepted")) {
      authority = decision.nextAuthority;
      if (AuthorityStateSchema.guards.Transitioning(authority.state)) {
        const transition = authority.state.transition;
        const nonce = modelNonce(transition);
        if (nonce === undefined)
          return { ok: false, step, message: `unparsable nonce: ${JSON.stringify(transition)}` };
        committed.set(
          modelFenceKey(
            authority.revision,
            transitionKind(transition),
            nonce,
            phaseIndex(transition),
          ),
          {
            revision: authority.revision,
            transition,
          },
        );
      }
    }
    const actualOutcome = Predicate.isTagged(decision, "Accepted")
      ? { _tag: "Accepted" }
      : { _tag: "Rejected", value: decision.code };
    const actualAuth = abstractAuthority(authority);
    if (
      !isDeepStrictEqual(actualOutcome, expected.outcome) ||
      (authority?.revision ?? 0) !== expected.revision ||
      !isDeepStrictEqual(actualAuth, expected.auth)
    )
      return {
        ok: false,
        step,
        message: `action=${action} input=${JSON.stringify(input)} decision=${JSON.stringify(decision)} expected=${JSON.stringify({ outcome: expected.outcome, revision: expected.revision, auth: expected.auth })} actual=${JSON.stringify({ outcome: actualOutcome, revision: authority?.revision ?? 0, auth: actualAuth })}`,
      };
  }
  return { ok: true };
};

let traces: ReadonlyArray<ReadonlyArray<ModelState>> | undefined;
const sampled = (): ReadonlyArray<ReadonlyArray<ModelState>> => {
  traces ??= generateTraces({
    model: "spec/quint/session_lease.qnt",
    seed: "0x5c077",
    traces: 200,
    maxSteps: 40,
  }).map((trace) => decodeTrace(normalizeItf(trace)).states);
  return traces;
};

it("replays every sampled model trace against the reducer", () => {
  const seen = new Set<string>();
  sampled().forEach((trace, index) => {
    trace.forEach((state) => seen.add(state["mbt::actionTaken"]));
    const result = replay(trace);
    assert.ok(result.ok, `trace ${index}: ${result.ok ? "" : result.message}`);
  });
  assert.deepStrictEqual([...seen].sort(), [...actions].sort());
}, 60_000);

it("detects a reducer divergence", () => {
  const trace = sampled().find((states) =>
    states.some(
      (state) =>
        state["mbt::actionTaken"] === "advance" && Predicate.isTagged(state.outcome, "Accepted"),
    ),
  );
  assert.ok(trace);
  const step = trace.findIndex(
    (state) =>
      state["mbt::actionTaken"] === "advance" && Predicate.isTagged(state.outcome, "Accepted"),
  );
  const changed = trace.map((state, index) =>
    index === step
      ? { ...state, outcome: { _tag: "Rejected" as const, value: "stale_phase" } }
      : state,
  );
  const result = replay(changed);
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.step === step);
}, 60_000);
