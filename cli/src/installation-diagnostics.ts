import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Clock, Data, Effect, Option, Schema } from "effect";
import { CliError, EXIT } from "./core";
import { scottyStateRoot } from "./local-paths";
import {
  FAILURE_OUTPUT_TAIL_CHARACTERS,
  redactProductionDeploymentOutput,
} from "./deployment-redaction.ts";

export const INSTALLATION_DIAGNOSTIC_VERSION = 1;
export const INSTALLATION_DIAGNOSTIC_DIRECTORY = "diagnostics";

const HostErrorShape = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Unknown),
});
const PrimitiveCause = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);
const decodeHostErrorShape = Schema.decodeUnknownOption(HostErrorShape);
const decodePrimitiveCause = Schema.decodeUnknownOption(PrimitiveCause);

export class InstallationHostFailure extends Data.TaggedError("InstallationHostFailure")<{
  readonly cause: unknown;
}> {}

export type InstallationDiagnosticOperation = "init" | "deploy" | "uninstall";
export type InstallationDiagnosticPhase = "plan" | "create" | "apply";

export interface InstallationDiagnosticContext {
  readonly installationName: string;
  readonly profile: string;
}

export interface InstallationDiagnosticCause {
  readonly name?: string;
  readonly message?: string;
  readonly cause?: InstallationDiagnosticCause;
}

export interface InstallationDiagnosticRecord {
  readonly version: typeof INSTALLATION_DIAGNOSTIC_VERSION;
  readonly recordedAt: string;
  readonly operation: InstallationDiagnosticOperation;
  readonly phase: InstallationDiagnosticPhase;
  readonly context: InstallationDiagnosticContext;
  readonly cause: InstallationDiagnosticCause;
}

export interface InstallationCommandFailureSpec {
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly operation: InstallationDiagnosticOperation;
  readonly phase: InstallationDiagnosticPhase;
  readonly installationName: string;
  readonly profile: string;
}

const boundText = (value: string): string => value.slice(0, FAILURE_OUTPUT_TAIL_CHARACTERS);

const primitiveCauseMessage = (value: typeof PrimitiveCause.Type): string => {
  if (typeof value === "string") return boundText(value);
  if (typeof value === "number") return boundText(`${value}`);
  return boundText(value ? "true" : "false");
};

const hostErrorProperty = (value: object, key: "name" | "message" | "cause"): unknown => {
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined && "value" in descriptor) return descriptor.value;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
};

const hostErrorShape = (value: unknown): unknown => {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
  const name = hostErrorProperty(value, "name");
  const message = hostErrorProperty(value, "message");
  const cause = hostErrorProperty(value, "cause");
  return {
    ...(name === undefined ? {} : { name }),
    ...(message === undefined ? {} : { message }),
    ...(cause === undefined ? {} : { cause }),
  };
};

const projectCause = (value: unknown, depth = 0): InstallationDiagnosticCause => {
  if (depth > 2) return {};
  const decoded = decodeHostErrorShape(hostErrorShape(value));
  if (Option.isSome(decoded)) {
    return {
      ...(decoded.value.name === undefined ? {} : { name: boundText(decoded.value.name) }),
      ...(decoded.value.message === undefined ? {} : { message: boundText(decoded.value.message) }),
      ...(decoded.value.cause === undefined
        ? {}
        : { cause: projectCause(decoded.value.cause, depth + 1) }),
    };
  }
  const primitive = decodePrimitiveCause(value);
  if (Option.isNone(primitive)) return {};
  return { message: primitiveCauseMessage(primitive.value) };
};

export const installationDiagnosticPath = (
  home: string,
  operation: InstallationDiagnosticOperation,
  phase: InstallationDiagnosticPhase,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string =>
  join(
    scottyStateRoot(home, environment),
    INSTALLATION_DIAGNOSTIC_DIRECTORY,
    `${operation}-${phase}.json`,
  );

export const renderInstallationFailureDiagnostic = (input: {
  readonly recordedAt: string;
  readonly operation: InstallationDiagnosticOperation;
  readonly phase: InstallationDiagnosticPhase;
  readonly context: InstallationDiagnosticContext;
  readonly cause: unknown;
  readonly environment?: Record<string, string | undefined>;
}): string => {
  const record: InstallationDiagnosticRecord = {
    version: INSTALLATION_DIAGNOSTIC_VERSION,
    recordedAt: input.recordedAt,
    operation: input.operation,
    phase: input.phase,
    context: {
      installationName: input.context.installationName,
      profile: input.context.profile,
    },
    cause: projectCause(input.cause),
  };
  return redactProductionDeploymentOutput(`${JSON.stringify(record, null, 2)}\n`, {
    ...input.environment,
  });
};

export const persistInstallationFailureDiagnostic = async (input: {
  readonly home: string;
  readonly recordedAt: string;
  readonly operation: InstallationDiagnosticOperation;
  readonly phase: InstallationDiagnosticPhase;
  readonly context: InstallationDiagnosticContext;
  readonly cause: unknown;
  readonly environment?: Record<string, string | undefined>;
}): Promise<string> => {
  const path = installationDiagnosticPath(
    input.home,
    input.operation,
    input.phase,
    input.environment,
  );
  const body = renderInstallationFailureDiagnostic(input);
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  await writeFile(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
  return path;
};

export const installationCommandFailure = (
  home: string,
  environment: Record<string, string | undefined>,
) =>
  Effect.fnUntraced(function* (cause: unknown, spec: InstallationCommandFailureSpec) {
    const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const persisted = yield* Effect.tryPromise({
      try: () =>
        persistInstallationFailureDiagnostic({
          home,
          recordedAt,
          operation: spec.operation,
          phase: spec.phase,
          context: {
            installationName: spec.installationName,
            profile: spec.profile,
          },
          cause,
          environment,
        }),
      catch: (persistCause) => new InstallationHostFailure({ cause: persistCause }),
    }).pipe(Effect.orElseSucceed(() => undefined));
    return yield* new CliError(
      spec.code,
      spec.message,
      persisted === undefined ? spec.hint : `${spec.hint} Diagnostic: ${persisted}`,
      EXIT.GENERIC,
    );
  });
