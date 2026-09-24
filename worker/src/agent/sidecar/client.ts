import { Clock, Data, Effect, Option, Result, Schedule, Schema } from "effect";
import { SidecarAgentSelectionSchema } from "../../../../protocol/agents/agent-selection";
import { agentDescriptors } from "../../../../protocol/agents/agents";
import type { PiConsoleImage } from "../../../../protocol/agents/pi/pi-console";
import type { CredentialGrant } from "../../../../protocol/credentials/credentials";
import {
  anthropicAccessHandle,
  githubManagedHandle,
  managedPiAccessToken,
  piAccessHandle,
  selectPiAuthGrant,
} from "../../credentials/managed";
import { SandboxRuntime, SandboxRuntimeFailure, shellQuote } from "../../sandbox/runtime";
import { sessionRoot } from "../../sandbox/workspace";
import { SessionConfigurationSchema } from "../../session-actor/configuration";
import {
  SIDECAR_CONTROL_GENERATION_HEADER,
  SIDECAR_CONTROL_TOKEN_HEADER,
  SidecarAdmission,
  SidecarControlToken,
  SidecarGeneration,
  SidecarInterruptResult,
  SidecarSaved,
  SidecarStartupFailure,
  type SidecarAgent,
  type SidecarPersistenceIdentity,
} from "./protocol";
import { readSidecarSnapshot } from "./runtime";

export const SIDECAR_RESUME_READINESS_TIMEOUT_MILLIS = 370_000;

const SidecarSandboxIdentitySchema = Schema.Struct({
  configuration: Schema.optionalKey(SessionConfigurationSchema),
  sessionId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/u)),
  generation: SidecarGeneration,
  selection: SidecarAgentSelectionSchema,
  token: SidecarControlToken,
});
export type SidecarSandboxIdentity = typeof SidecarSandboxIdentitySchema.Type;
const SidecarSandboxStartIdentitySchema = Schema.Struct({
  ...SidecarSandboxIdentitySchema.fields,
  configuration: SessionConfigurationSchema,
});
export type SidecarSandboxStartIdentity = typeof SidecarSandboxStartIdentitySchema.Type;
const decodeIdentity = Schema.decodeUnknownEffect(SidecarSandboxIdentitySchema);
const decodeStartIdentity = Schema.decodeUnknownEffect(SidecarSandboxStartIdentitySchema);
const strict = { onExcessProperty: "error" } as const;
const decodeAdmission = Schema.decodeUnknownEffect(Schema.fromJsonString(SidecarAdmission), strict);
const decodeInterruptResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SidecarInterruptResult),
  strict,
);
const decodeSaved = Schema.decodeUnknownEffect(Schema.fromJsonString(SidecarSaved), strict);
const decodeStartupFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(SidecarStartupFailure),
);

export class SidecarMessageAdmissionUnknown extends Data.TaggedError(
  "SidecarMessageAdmissionUnknown",
)<{}> {}
export class SidecarInterruptAdmissionUnknown extends Data.TaggedError(
  "SidecarInterruptAdmissionUnknown",
)<{}> {}

interface LaunchContext {
  readonly identity: SidecarSandboxStartIdentity;
  readonly grants: ReadonlyArray<CredentialGrant>;
  readonly now: number;
  readonly restore: typeof SidecarPersistenceIdentity.Type | undefined;
  /** Launch fields every agent shares: private runtime paths, workspace and session policy. */
  readonly common: {
    readonly agentInstructionsPath: string;
    readonly environment: SidecarSandboxStartIdentity["configuration"]["environment"];
    readonly sandboxBundleDigest?: string;
    readonly runtimeDir: string;
    readonly workspace: string;
    readonly sessionId: string;
    readonly githubHandle?: string;
  };
}
interface SidecarSpec {
  readonly port: number;
  readonly server: string;
  /** Agent-specific launch payload, or the reason Session credentials cannot start it. */
  readonly launch: (context: LaunchContext) => Result.Result<object, string>;
}

const specs: { readonly [Agent in SidecarAgent]: SidecarSpec } = {
  codex: {
    port: 43_118,
    server: "/usr/local/bin/scotty-codex-server",
    launch: ({ identity, grants, now, restore, common }) => {
      const selected = selectPiAuthGrant(grants);
      const handle = piAccessHandle(grants);
      if (
        Result.isFailure(selected) ||
        handle === undefined ||
        selected.success.expires === undefined ||
        selected.success.expires <= now
      )
        return Result.fail("Codex requires one current OpenAI access credential");
      return Result.succeed({
        ...common,
        binary: "/usr/local/bin/codex",
        model: identity.selection.model,
        effort: identity.selection.effort,
        ephemeral: false,
        ...(restore === undefined ? {} : { resumeThreadId: restore.threadId }),
        credential: { sentinel: managedPiAccessToken(handle), expiresAt: selected.success.expires },
      });
    },
  },
  claude: {
    port: 43_119,
    server: "/usr/local/bin/scotty-claude-server",
    launch: ({ identity, grants, restore, common }) => {
      const handle = anthropicAccessHandle(grants);
      if (handle === undefined) return Result.fail("Claude Code requires an Anthropic credential");
      return Result.succeed({
        ...common,
        model: identity.selection.model,
        effort: identity.selection.effort,
        ...(restore === undefined ? {} : { resumeSessionId: restore.threadId }),
        credential: { sentinel: handle },
      });
    },
  },
};

const label = (agent: SidecarAgent) => agentDescriptors[agent].label;
const failure = (message: string) => new SandboxRuntimeFailure({ reason: "transport", message });
const privateRoot = (agent: SidecarAgent, generation: string) =>
  `/tmp/scotty-${agent}-${generation}`;
export const sidecarProcessId = (agent: SidecarAgent, generation: string) =>
  `scotty-${agent}-${generation}`;
export const codexSandboxHome = (generation: string) =>
  `${privateRoot("codex", generation)}/runtime/codex-home`;
const isExited = (status: string) => ["completed", "failed", "killed", "error"].includes(status);

const headers = (identity: SidecarSandboxIdentity) => ({
  [SIDECAR_CONTROL_GENERATION_HEADER]: identity.generation,
  [SIDECAR_CONTROL_TOKEN_HEADER]: identity.token,
  "content-type": "application/json",
});
const post = Effect.fnUntraced(function* (
  identity: SidecarSandboxIdentity,
  path: string,
  body?: unknown,
) {
  const runtime = yield* SandboxRuntime;
  return yield* runtime.fetchPortBody(
    path,
    specs[identity.selection.agent].port,
    "POST",
    undefined,
    headers(identity),
    body === undefined ? undefined : JSON.stringify(body),
  );
});

export const readSidecarSandbox = Effect.fnUntraced(function* (
  input: SidecarSandboxIdentity,
  threadId?: string,
) {
  const identity = yield* decodeIdentity(input).pipe(
    Effect.mapError(() => failure("Sidecar identity is invalid")),
  );
  const agent = identity.selection.agent;
  const runtime = yield* SandboxRuntime;
  const response = yield* runtime
    .fetchPortBody("/snapshot", specs[agent].port, "GET", undefined, headers(identity))
    .pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(failure(`${label(agent)} snapshot deadline exceeded`)),
      }),
    );
  if (response.status !== 200) return yield* failure(`${label(agent)} snapshot is unavailable`);
  const snapshot = yield* readSidecarSnapshot(response.body, {
    generation: identity.generation,
    ...(threadId === undefined ? {} : { threadId }),
  }).pipe(Effect.mapError(() => failure(`${label(agent)} snapshot fence is invalid`)));
  if (
    snapshot.agent !== agent ||
    snapshot.settings.model !== identity.selection.model ||
    snapshot.settings.effort !== identity.selection.effort ||
    snapshot.settings.workspace !== sessionRoot(identity.sessionId)
  )
    return yield* failure(`${label(agent)} native settings do not match Session authority`);
  return snapshot;
});

const reportEarlyExit = Effect.fnUntraced(function* (
  identity: SidecarSandboxIdentity,
  cause: SandboxRuntimeFailure,
) {
  const agent = identity.selection.agent;
  const runtime = yield* SandboxRuntime;
  const process = yield* Effect.result(
    runtime.getProcess(sidecarProcessId(agent, identity.generation)),
  );
  if (Result.isFailure(process) || process.success === null || !isExited(process.success.status))
    return yield* cause;
  const exited = process.success;
  const logs = yield* (exited.getLogs?.() ?? Effect.fail(cause)).pipe(
    Effect.timeout("1 second"),
    Effect.option,
  );
  const startup = logs.pipe(
    Option.flatMap(({ stderr }) =>
      Option.firstSomeOf(
        stderr
          .slice(-8_192)
          .split("\n")
          .reverse()
          .map((line) => decodeStartupFailure(line))
          .filter(
            (record) =>
              Option.isSome(record) &&
              (record.value.generation === undefined ||
                record.value.generation === identity.generation),
          ),
      ),
    ),
  );
  console.error(`${label(agent)} supervisor exited before readiness`, {
    sessionId: identity.sessionId,
    generation: identity.generation,
    processStatus: exited.status,
    exitCode: exited.exitCode ?? null,
    ...Option.match(startup, {
      onNone: () => ({}),
      onSome: ({ stage, code }) => ({ startupStage: stage, startupCode: code }),
    }),
  });
  return yield* new SandboxRuntimeFailure({
    reason: "nonzero_exit",
    message: `${label(agent)} process exited before readiness`,
  });
});

export const waitForSidecarSandbox = Effect.fnUntraced(function* (
  identity: SidecarSandboxIdentity,
  timeoutMillis = 30_000,
) {
  const agent = identity.selection.agent;
  const snapshot = yield* readSidecarSandbox(identity).pipe(
    Effect.catch((error) => reportEarlyExit(identity, error)),
    Effect.retry({
      while: (error) => error.reason !== "nonzero_exit",
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.timeoutOrElse({
      duration: timeoutMillis,
      orElse: () => Effect.fail(failure(`${label(agent)} readiness deadline exceeded`)),
    }),
  );
  if (!snapshot.ready || snapshot.failure !== null)
    return yield* failure(`${label(agent)} is not ready`);
  return snapshot;
});

export const startSidecarSandbox = Effect.fnUntraced(function* (
  input: SidecarSandboxStartIdentity,
  grants: ReadonlyArray<CredentialGrant>,
  restore?: typeof SidecarPersistenceIdentity.Type,
) {
  const identity = yield* decodeStartIdentity(input).pipe(
    Effect.mapError(
      () =>
        new SandboxRuntimeFailure({
          reason: "nonzero_exit",
          message: "Sidecar identity is invalid",
        }),
    ),
  );
  const agent = identity.selection.agent;
  const spec = specs[agent];
  const root = privateRoot(agent, identity.generation);
  const runtimeDir = `${root}/runtime`;
  const agentInstructionsPath = `${runtimeDir}.agent-instructions.md`;
  const githubHandle = githubManagedHandle(grants);
  const { configuration } = identity;
  const launch = spec.launch({
    identity,
    grants,
    now: yield* Clock.currentTimeMillis,
    restore,
    common: {
      agentInstructionsPath,
      environment: configuration.environment,
      ...(configuration.bundleDigest === null
        ? {}
        : { sandboxBundleDigest: configuration.bundleDigest }),
      runtimeDir,
      workspace: sessionRoot(identity.sessionId),
      sessionId: identity.sessionId,
      ...(githubHandle === undefined ? {} : { githubHandle }),
    },
  });
  if (Result.isFailure(launch))
    return yield* new SandboxRuntimeFailure({ reason: "nonzero_exit", message: launch.failure });
  const runtime = yield* SandboxRuntime;
  // A fresh private parent is exclusive to this generation. Never recycle it on ambiguous launch.
  yield* runtime.execChecked(`umask 077 && mkdir ${shellQuote(root)}`);
  yield* runtime.writeFile(`${root}/control.token`, identity.token);
  yield* runtime.writeFile(agentInstructionsPath, configuration.agentInstructions);
  yield* runtime.execChecked(
    `chmod 600 ${shellQuote(`${root}/control.token`)} ${shellQuote(agentInstructionsPath)}`,
  );
  const start = {
    generation: identity.generation,
    port: spec.port,
    ...(restore === undefined ? {} : { restore }),
    tokenFile: `${root}/control.token`,
    launch: launch.success,
  };
  const process = yield* runtime.startProcess(
    `${spec.server} ${shellQuote(JSON.stringify(start))}`,
    {
      cwd: sessionRoot(identity.sessionId),
      processId: sidecarProcessId(agent, identity.generation),
      autoCleanup: true,
    },
  );
  return process.id;
});

export const admitSidecarSandbox = Effect.fnUntraced(function* (
  identity: SidecarSandboxIdentity,
  threadId: string,
  text: string,
  reconcile: boolean,
  images?: ReadonlyArray<PiConsoleImage>,
) {
  const name = label(identity.selection.agent);
  const before = yield* readSidecarSandbox(identity, threadId);
  if (!reconcile && before.prompt.status === "idle") {
    if (!before.ready || before.failure !== null)
      return yield* failure(`${name} is not ready for admission`);
    // The actor persists TransportVerifying before this POST. A lost response may only be read back.
    yield* post(identity, "/prompt", {
      threadId,
      text,
      ...(images === undefined ? {} : { images }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(failure(`${name} admission reply deadline exceeded`)),
      }),
      Effect.result,
    );
  }
  const snapshot = yield* readSidecarSandbox(identity, threadId);
  if (
    snapshot.prompt.status === "idle" ||
    snapshot.prompt.status === "admitting" ||
    snapshot.prompt.turnId === null
  )
    return yield* failure(`${name} prompt admission remains unknown`);
  return { snapshot, turnId: snapshot.prompt.turnId };
});

const messageBody = (
  message: {
    readonly threadId: string;
    readonly text: string;
    readonly clientUserMessageId: string | undefined;
    readonly images: ReadonlyArray<PiConsoleImage> | undefined;
  },
  delivery: "auto" | "followUp" | "reconcile",
  steerTurnId: string | undefined,
) => {
  const { threadId, text, clientUserMessageId, images } = message;
  const clientId = clientUserMessageId === undefined ? {} : { clientUserMessageId };
  return steerTurnId === undefined
    ? {
        mode: "message",
        threadId,
        text,
        ...(delivery === "reconcile" ? { reconcileOnly: true } : {}),
        ...clientId,
        images,
      }
    : { mode: "steer", threadId, text, expectedTurnId: steerTurnId, ...clientId, images };
};

export const sendSidecarSandboxMessage = Effect.fnUntraced(function* (
  input: SidecarSandboxIdentity,
  threadId: string,
  text: string,
  clientUserMessageId?: string,
  delivery: "auto" | "followUp" | "reconcile" = "auto",
  images?: ReadonlyArray<PiConsoleImage>,
) {
  const identity = yield* decodeIdentity(input).pipe(
    Effect.mapError(() => failure("Sidecar identity is invalid")),
  );
  const name = label(identity.selection.agent);
  const unknown = () => new SidecarMessageAdmissionUnknown();
  const before = yield* readSidecarSandbox(identity, threadId);
  if (!before.ready || before.failure !== null)
    return yield* failure(`${name} is not ready for a message`);
  const steerTurnId =
    delivery === "auto" && before.prompt.status === "running" ? before.prompt.turnId : undefined;
  if (delivery === "auto" && steerTurnId === undefined && before.prompt.status !== "terminal")
    return yield* failure(`${name} message admission is unavailable`);
  const body = messageBody({ threadId, text, clientUserMessageId, images }, delivery, steerTurnId);
  const response = yield* post(identity, "/message", body).pipe(
    Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.fail(unknown()) }),
    Effect.mapError(unknown),
  );
  if (response.status !== 202) return yield* unknown();
  const admission = yield* decodeAdmission(response.body).pipe(Effect.mapError(unknown));
  if (
    admission.generation !== identity.generation ||
    admission.threadId !== threadId ||
    (steerTurnId !== undefined && admission.turnId !== steerTurnId)
  )
    return yield* unknown();
  const snapshot = yield* readSidecarSandbox(identity, threadId).pipe(Effect.mapError(unknown));
  if (
    steerTurnId !== undefined &&
    (snapshot.prompt.status === "idle" ||
      snapshot.prompt.status === "admitting" ||
      snapshot.prompt.turnId !== admission.turnId)
  )
    return yield* unknown();
  return {
    mode: steerTurnId === undefined ? "message" : "steer",
    snapshot,
    turnId: admission.turnId,
  } as const;
});

export const interruptSidecarSandbox = Effect.fnUntraced(function* (
  input: SidecarSandboxIdentity,
  threadId: string,
  turnId: string,
) {
  const identity = yield* decodeIdentity(input).pipe(
    Effect.mapError(() => failure("Sidecar identity is invalid")),
  );
  const name = label(identity.selection.agent);
  const unknown = () => new SidecarInterruptAdmissionUnknown();
  const before = yield* readSidecarSandbox(identity, threadId);
  if (!before.ready || before.failure !== null)
    return yield* failure(`${name} is not ready for an interrupt`);
  if (before.prompt.status !== "running" || before.prompt.turnId !== turnId)
    return yield* failure(`${name} interrupt requires the current active turn`);
  const response = yield* post(identity, "/interrupt", { threadId, turnId }).pipe(
    Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.fail(unknown()) }),
    Effect.mapError(unknown),
    Effect.result,
  );
  const after = yield* readSidecarSandbox(identity, threadId).pipe(Effect.mapError(unknown));
  if (after.prompt.status !== "terminal" || after.prompt.turnId !== turnId) return yield* unknown();
  const outcome = after.prompt.outcome;
  if (Result.isFailure(response)) return { snapshot: after, turnId, outcome } as const;
  if (response.success.status !== 202) return yield* unknown();
  const result = yield* decodeInterruptResult(response.success.body).pipe(Effect.mapError(unknown));
  if (
    result.generation !== identity.generation ||
    result.threadId !== threadId ||
    result.turnId !== turnId ||
    result.status !== outcome
  )
    return yield* unknown();
  return { snapshot: after, turnId, outcome } as const;
});

export const saveSidecarSandbox = Effect.fnUntraced(function* (
  identity: SidecarSandboxIdentity,
  expected: typeof SidecarPersistenceIdentity.Type,
) {
  const name = label(identity.selection.agent);
  const response = yield* post(identity, "/save").pipe(
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.fail(failure(`${name} save outcome is unknown`)),
    }),
  );
  if (response.status !== 200) return yield* failure(`${name} save failed`);
  const saved = yield* decodeSaved(response.body).pipe(
    Effect.mapError(() => failure(`${name} saved state is invalid`)),
  );
  if (
    saved.generation !== identity.generation ||
    saved.threadId !== expected.threadId ||
    saved.initialTurnId !== expected.initialTurnId
  )
    return yield* failure(`${name} saved state does not match Session authority`);
  return saved;
});

export const stopSavedSidecarSandbox = Effect.fnUntraced(function* (input: SidecarSandboxIdentity) {
  const identity = yield* decodeIdentity(input).pipe(
    Effect.mapError(() => failure("Sidecar identity is invalid")),
  );
  const agent = identity.selection.agent;
  const runtime = yield* SandboxRuntime;
  const processId = sidecarProcessId(agent, identity.generation);
  const process = yield* runtime.getProcess(processId);
  if (process !== null && !isExited(process.status)) {
    yield* Effect.result(process.kill());
    yield* Effect.result(process.waitForExit(20_000));
    const observed = yield* runtime.getProcess(processId);
    if (observed !== null && !isExited(observed.status))
      return yield* failure(`${label(agent)} saved server exit is unconfirmed`);
  }
  // Only reclaim the generation's private root after the old server has exited.
  yield* runtime.execChecked(`rm -rf -- ${shellQuote(privateRoot(agent, identity.generation))}`);
});
