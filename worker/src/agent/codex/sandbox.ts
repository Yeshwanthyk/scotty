import { CodexPersistenceIdentity } from "./persistence-format";
import { SessionConfigurationSchema } from "../../session-actor/configuration";
import { Clock, Data, Effect, Result, Schedule, Schema } from "effect";
import { CodexAgentSelectionSchema } from "../../../../protocol/agent-selection";
import type { CredentialGrant } from "../../../../protocol/credentials";
import { managedPiAccessToken, piAccessHandle, selectPiAuthGrant } from "../../credentials/managed";
import { SandboxRuntime, SandboxRuntimeFailure, shellQuote } from "../../sandbox/runtime";
import { sessionRoot } from "../../sandbox/workspace";
import {
  CodexControlToken,
  CodexAdmission,
  CodexInterruptResult,
  CodexGeneration,
  CODEX_CONTROL_GENERATION_HEADER,
  CODEX_CONTROL_TOKEN_HEADER,
  CODEX_CONTROL_MAX_RESPONSE,
  readCodexSnapshot,
} from "./runtime";

export const CODEX_SANDBOX_PORT = 43_118;
const CodexSandboxIdentitySchema = Schema.Struct({
  configuration: Schema.optionalKey(SessionConfigurationSchema),
  sessionId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{12}$/u)),
  generation: CodexGeneration,
  selection: CodexAgentSelectionSchema,
  token: CodexControlToken,
});
export type CodexSandboxIdentity = typeof CodexSandboxIdentitySchema.Type;
const decodeIdentity = Schema.decodeUnknownEffect(CodexSandboxIdentitySchema);
const decodeAdmission = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexAdmission), {
  onExcessProperty: "error",
});
const decodeInterruptResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CodexInterruptResult),
  { onExcessProperty: "error" },
);
export const codexSandboxProcessId = (generation: string) => `scotty-codex-${generation}`;
export const codexSandboxHome = (generation: string) =>
  `/tmp/scotty-codex-${generation}/runtime/codex-home`;
const failure = (message: string) => new SandboxRuntimeFailure({ reason: "transport", message });
export class CodexMessageAdmissionUnknown extends Data.TaggedError(
  "CodexMessageAdmissionUnknown",
)<{}> {}
export class CodexInterruptAdmissionUnknown extends Data.TaggedError(
  "CodexInterruptAdmissionUnknown",
)<{}> {}
const headers = (identity: CodexSandboxIdentity) => ({
  [CODEX_CONTROL_GENERATION_HEADER]: identity.generation,
  [CODEX_CONTROL_TOKEN_HEADER]: identity.token,
  "content-type": "application/json",
});

export const readCodexSandbox = Effect.fnUntraced(function* (
  input: CodexSandboxIdentity,
  threadId?: string,
) {
  const identity = yield* decodeIdentity(input).pipe(
    Effect.mapError(() => failure("Codex identity is invalid")),
  );
  const runtime = yield* SandboxRuntime;
  const response = yield* runtime
    .fetchPortBody(
      "/snapshot",
      CODEX_SANDBOX_PORT,
      "GET",
      CODEX_CONTROL_MAX_RESPONSE,
      headers(identity),
    )
    .pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(failure("Codex snapshot deadline exceeded")),
      }),
    );
  if (response.status !== 200) return yield* failure("Codex snapshot is unavailable");
  const snapshot = yield* readCodexSnapshot(response.body, {
    generation: identity.generation,
    ...(threadId === undefined ? {} : { threadId }),
  }).pipe(Effect.mapError(() => failure("Codex snapshot fence is invalid")));
  if (
    snapshot.settings.model !== identity.selection.model ||
    snapshot.settings.effort !== identity.selection.effort ||
    snapshot.settings.workspace !== sessionRoot(identity.sessionId)
  )
    return yield* failure("Codex native settings do not match Session authority");
  return snapshot;
});

export const waitForCodexSandbox = Effect.fnUntraced(function* (identity: CodexSandboxIdentity) {
  const snapshot = yield* readCodexSandbox(identity).pipe(
    Effect.retry({ times: 29, schedule: Schedule.spaced("1 second") }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(failure("Codex readiness deadline exceeded")),
    }),
  );
  if (!snapshot.ready || snapshot.failure !== null) return yield* failure("Codex is not ready");
  return snapshot;
});

export const startCodexSandbox = Effect.fnUntraced(function* (
  input: CodexSandboxIdentity,
  grants: ReadonlyArray<CredentialGrant>,
  restore?: typeof CodexPersistenceIdentity.Type,
) {
  const identity = yield* decodeIdentity(input).pipe(
    Effect.mapError(
      () =>
        new SandboxRuntimeFailure({ reason: "nonzero_exit", message: "Codex identity is invalid" }),
    ),
  );
  const runtime = yield* SandboxRuntime;
  const selected = selectPiAuthGrant(grants);
  const handle = piAccessHandle(grants);
  const now = yield* Clock.currentTimeMillis;
  if (
    Result.isFailure(selected) ||
    handle === undefined ||
    selected.success.expires === undefined ||
    selected.success.expires <= now
  )
    return yield* new SandboxRuntimeFailure({
      reason: "nonzero_exit",
      message: "Codex requires one current managed access grant",
    });
  const root = `/tmp/scotty-codex-${identity.generation}`;
  // A fresh private parent is exclusive to this generation. Never recycle it on ambiguous launch.
  yield* runtime.execChecked(`umask 077 && mkdir ${shellQuote(root)}`);
  yield* runtime.writeFile(`${root}/control.token`, identity.token);
  yield* runtime.execChecked(`chmod 600 ${shellQuote(`${root}/control.token`)}`);
  const start = {
    generation: identity.generation,
    port: CODEX_SANDBOX_PORT,
    ...(restore === undefined ? {} : { restore }),
    tokenFile: `${root}/control.token`,
    launch: {
      ...(identity.configuration === undefined
        ? {}
        : {
            environment: identity.configuration.environment,
            ...(identity.configuration.bundleDigest === null
              ? {}
              : {
                  sandboxBundleDigest: identity.configuration.bundleDigest,
                }),
          }),
      binary: "/usr/local/bin/codex",
      runtimeDir: `${root}/runtime`,
      workspace: sessionRoot(identity.sessionId),
      sessionId: identity.sessionId,
      model: identity.selection.model,
      effort: identity.selection.effort,
      ephemeral: false,
      ...(restore === undefined ? {} : { resumeThreadId: restore.threadId }),
      credential: { sentinel: managedPiAccessToken(handle), expiresAt: selected.success.expires },
    },
  };
  const process = yield* runtime.startProcess(
    `/usr/local/bin/scotty-codex-server ${shellQuote(JSON.stringify(start))}`,
    {
      cwd: sessionRoot(identity.sessionId),
      processId: codexSandboxProcessId(identity.generation),
      autoCleanup: true,
    },
  );
  return process.id;
});

export const admitCodexSandbox = Effect.fnUntraced(function* (
  identity: CodexSandboxIdentity,
  threadId: string,
  text: string,
  reconcile: boolean,
) {
  const runtime = yield* SandboxRuntime;
  const before = yield* readCodexSandbox(identity, threadId);
  if (!reconcile && before.prompt.status === "idle") {
    if (!before.ready || before.failure !== null)
      return yield* failure("Codex is not ready for admission");
    // The actor persists TransportVerifying before this POST. A lost response may only be read back.
    yield* runtime
      .fetchPortBody(
        "/prompt",
        CODEX_SANDBOX_PORT,
        "POST",
        CODEX_CONTROL_MAX_RESPONSE,
        headers(identity),
        JSON.stringify({ threadId, text }),
      )
      .pipe(
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () => Effect.fail(failure("Codex admission reply deadline exceeded")),
        }),
        Effect.result,
      );
  }
  const snapshot = yield* readCodexSandbox(identity, threadId);
  if (snapshot.prompt.status === "idle" || snapshot.prompt.status === "admitting")
    return yield* failure("Codex prompt admission remains unknown");
  const turnId = snapshot.prompt.turnId;
  if (turnId === null) return yield* failure("Codex prompt admission remains unknown");
  return { snapshot, turnId };
});

export const sendCodexSandboxMessage = Effect.fnUntraced(function* (
  input: CodexSandboxIdentity,
  threadId: string,
  text: string,
  clientUserMessageId?: string,
  delivery: "auto" | "followUp" | "reconcile" = "auto",
) {
  const identity = yield* decodeIdentity(input).pipe(
    Effect.mapError(() => failure("Codex identity is invalid")),
  );
  const runtime = yield* SandboxRuntime;
  const before = yield* readCodexSandbox(identity, threadId);
  if (!before.ready || before.failure !== null)
    return yield* failure("Codex is not ready for a message");
  const mode =
    delivery !== "auto"
      ? { mode: "message" as const }
      : before.prompt.status === "running"
        ? { mode: "steer" as const, expectedTurnId: before.prompt.turnId }
        : before.prompt.status === "terminal"
          ? { mode: "message" as const }
          : yield* failure("Codex message admission is unavailable");
  const body =
    mode.mode === "steer"
      ? {
          mode: mode.mode,
          threadId,
          text,
          expectedTurnId: mode.expectedTurnId,
          ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
        }
      : {
          mode: mode.mode,
          threadId,
          text,
          ...(delivery === "reconcile" ? { reconcileOnly: true } : {}),
          ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
        };
  const response = yield* runtime
    .fetchPortBody(
      "/message",
      CODEX_SANDBOX_PORT,
      "POST",
      CODEX_CONTROL_MAX_RESPONSE,
      headers(identity),
      JSON.stringify(body),
    )
    .pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(new CodexMessageAdmissionUnknown()),
      }),
      Effect.mapError(() => new CodexMessageAdmissionUnknown()),
    );
  if (response.status !== 202) return yield* new CodexMessageAdmissionUnknown();
  const admission = yield* decodeAdmission(response.body).pipe(
    Effect.mapError(() => new CodexMessageAdmissionUnknown()),
  );
  if (
    admission.generation !== identity.generation ||
    admission.threadId !== threadId ||
    (mode.mode === "steer" && admission.turnId !== mode.expectedTurnId)
  )
    return yield* new CodexMessageAdmissionUnknown();
  const snapshot = yield* readCodexSandbox(identity, threadId).pipe(
    Effect.mapError(() => new CodexMessageAdmissionUnknown()),
  );
  if (
    mode.mode === "steer" &&
    (snapshot.prompt.status === "idle" ||
      snapshot.prompt.status === "admitting" ||
      snapshot.prompt.turnId !== admission.turnId)
  )
    return yield* new CodexMessageAdmissionUnknown();
  return { mode: mode.mode, snapshot, turnId: admission.turnId } as const;
});

export const interruptCodexSandbox = Effect.fnUntraced(function* (
  input: CodexSandboxIdentity,
  threadId: string,
  turnId: string,
) {
  const identity = yield* decodeIdentity(input).pipe(
    Effect.mapError(() => failure("Codex identity is invalid")),
  );
  const runtime = yield* SandboxRuntime;
  const before = yield* readCodexSandbox(identity, threadId);
  if (!before.ready || before.failure !== null)
    return yield* failure("Codex is not ready for an interrupt");
  if (before.prompt.status !== "running" || before.prompt.turnId !== turnId)
    return yield* failure("Codex interrupt requires the current active turn");

  const response = yield* runtime
    .fetchPortBody(
      "/interrupt",
      CODEX_SANDBOX_PORT,
      "POST",
      CODEX_CONTROL_MAX_RESPONSE,
      headers(identity),
      JSON.stringify({ threadId, turnId }),
    )
    .pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(new CodexInterruptAdmissionUnknown()),
      }),
      Effect.mapError(() => new CodexInterruptAdmissionUnknown()),
      Effect.result,
    );
  const after = yield* readCodexSandbox(identity, threadId).pipe(
    Effect.mapError(() => new CodexInterruptAdmissionUnknown()),
  );
  if (
    after.prompt.status !== "terminal" ||
    after.prompt.turnId !== turnId ||
    (after.prompt.outcome !== "interrupted" &&
      after.prompt.outcome !== "completed" &&
      after.prompt.outcome !== "failed")
  )
    return yield* new CodexInterruptAdmissionUnknown();

  if (Result.isFailure(response)) return { snapshot: after, turnId, outcome: after.prompt.outcome };
  if (response.success.status !== 202) return yield* new CodexInterruptAdmissionUnknown();
  const result = yield* decodeInterruptResult(response.success.body).pipe(
    Effect.mapError(() => new CodexInterruptAdmissionUnknown()),
  );
  if (
    result.generation !== identity.generation ||
    result.threadId !== threadId ||
    result.turnId !== turnId ||
    result.status !== after.prompt.outcome
  )
    return yield* new CodexInterruptAdmissionUnknown();
  return { snapshot: after, turnId, outcome: result.status } as const;
});

const decodeSaved = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      generation: CodexGeneration,
      ...CodexPersistenceIdentity.fields,
    }),
  ),
  { onExcessProperty: "error" },
);
export const saveCodexSandbox = Effect.fnUntraced(function* (
  identity: CodexSandboxIdentity,
  expected: typeof CodexPersistenceIdentity.Type,
) {
  const runtime = yield* SandboxRuntime;
  const response = yield* runtime
    .fetchPortBody(
      "/save",
      CODEX_SANDBOX_PORT,
      "POST",
      CODEX_CONTROL_MAX_RESPONSE,
      headers(identity),
    )
    .pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(failure("Codex save outcome is unknown")),
      }),
    );
  if (response.status !== 200) return yield* failure("Codex save failed");
  const saved = yield* decodeSaved(response.body).pipe(
    Effect.mapError(() => failure("Codex saved state is invalid")),
  );
  if (
    saved.generation !== identity.generation ||
    saved.threadId !== expected.threadId ||
    saved.initialTurnId !== expected.initialTurnId
  )
    return yield* failure("Codex saved state does not match Session authority");
  return saved;
});
