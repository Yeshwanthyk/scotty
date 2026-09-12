import { isDeepStrictEqual } from "node:util";
import { Effect, Option, Result, Schema } from "effect";
import {
  CloudSettingsSchema,
  decodeCloudSettingsSnapshot,
  defaultCloudSettings,
  type CloudSettings,
} from "../../protocol/cloud-settings";
import { decodeAgentSelection } from "../../protocol/agent-selection";
import { isRepositoryIdentity, repositoryIdentityKey } from "../../protocol/repository";
import { CliError, EXIT } from "./core";
import { invalidResponse, usage } from "./pure";
import { decodeRepositoriesResponse, decodeRepositoryResponse } from "./schemas";
import { requestJson } from "./transport";

export interface InitCloudChoices {
  readonly agent?: "pi" | "codex";
  readonly modelProvider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly repos?: string;
  readonly environment?: string;
}

const decodeCloudSettings = Schema.decodeUnknownResult(CloudSettingsSchema);

export const parseInitCloudChoices = Effect.fnUntraced(function* (input: InitCloudChoices) {
  const repos = input.repos?.trim() ? input.repos.split(",").map((repo) => repo.trim()) : [];
  if (
    repos.some((repo) => !isRepositoryIdentity(repo)) ||
    new Set(repos.map(repositoryIdentityKey)).size !== repos.length
  )
    return yield* usage("--repos must be unique OWNER/NAME identities separated by commas");
  const environment: Record<string, string> = {};
  if (input.environment?.trim()) {
    for (const entry of input.environment.split(",")) {
      const separator = entry.indexOf("=");
      const key = entry.slice(0, separator).trim();
      if (separator <= 0 || Object.hasOwn(environment, key))
        return yield* usage("--env must contain unique KEY=VALUE entries separated by commas");
      environment[key] = entry.slice(separator + 1);
    }
  }
  const agent = input.agent ?? "pi";
  const selection = decodeAgentSelection({
    agent,
    ...(agent === "codex"
      ? { model: defaultCloudSettings.codex.model, effort: defaultCloudSettings.codex.effort }
      : {}),
    ...(input.modelProvider === undefined ? {} : { modelProvider: input.modelProvider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  });
  if (Result.isFailure(selection))
    return yield* usage(
      "Invalid agent model settings; Codex requires a supported model and effort",
    );
  const settings = {
    agent,
    pi: agent === "pi" ? selection.success : defaultCloudSettings.pi,
    codex: agent === "codex" ? selection.success : defaultCloudSettings.codex,
    environment,
  };
  const validated = decodeCloudSettings(settings);
  if (Result.isFailure(validated))
    return yield* usage("Invalid application environment or agent settings");
  return { settings: validated.success, repositories: repos };
});

export const configureInitCloud = Effect.fnUntraced(function* (input: {
  readonly target: { readonly host: string; readonly token: string };
  readonly settings: CloudSettings;
  readonly repositories: ReadonlyArray<string>;
  readonly settingsExplicit: boolean;
}) {
  const current = decodeCloudSettingsSnapshot(yield* requestJson(input.target, "/api/settings"));
  if (Result.isFailure(current)) return yield* invalidResponse("Server returned invalid settings");
  if (
    current.success.revision > 0 &&
    input.settingsExplicit &&
    !isDeepStrictEqual(current.success.settings, input.settings)
  )
    return yield* new CliError(
      "settings_conflict",
      "Cloud settings have changed since initialization",
      "Edit the current values in browser Settings; init only resumes its original setup.",
      EXIT.WRONG_STATE,
    );
  if (current.success.revision === 0) {
    const updated = decodeCloudSettingsSnapshot(
      yield* requestJson(input.target, "/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: current.success.revision,
          idempotencyKey: crypto.randomUUID(),
          settings: input.settings,
        }),
      }),
    );
    if (Result.isFailure(updated))
      return yield* invalidResponse("Server returned invalid settings");
  }
  if (input.repositories.length > 0) {
    const existing = decodeRepositoriesResponse(yield* requestJson(input.target, "/api/repos"));
    if (Option.isNone(existing))
      return yield* invalidResponse("Server returned invalid repositories");
    const keys = new Set(existing.value.map(({ repo }) => repositoryIdentityKey(repo)));
    for (const repo of input.repositories) {
      if (keys.has(repositoryIdentityKey(repo))) continue;
      const added = decodeRepositoryResponse(
        yield* requestJson(input.target, "/api/repos", {
          method: "POST",
          body: JSON.stringify({ repo }),
        }),
      );
      if (Option.isNone(added))
        return yield* invalidResponse("Server returned an invalid repository registration");
      keys.add(repositoryIdentityKey(repo));
    }
  }
});

export const initCloudFailure = (error: CliError): CliError =>
  error.code === "settings_conflict"
    ? error
    : new CliError(
        error.code,
        // oxlint-disable-next-line scotty/no-unknown-error-message -- boundary: typed CLI failure is rewrapped after the remote setup step
        error.message,
        "The installation pointer is saved. Retry scotty init with the same name and setup flags; cloud setup will resume.",
        error.exitCode,
      );
