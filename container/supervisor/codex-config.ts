import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { Agent } from "./runner.js";
import { AgentError } from "./runner.js";
import { processEnv } from "./runtime.js";

// JSON basic-string escapes also satisfy TOML except for DEL (U+007F).
// The agent schema rejects lone surrogates in every string written to this config.
export const toml = (value: string) => JSON.stringify(value).replace(/\u007f/g, "\\u007f");
export const codexHome = () => processEnv("SCOTTY_CODEX_HOME") || "/home/scotty/.codex";

export const launchCodex = (
  config: Extract<Agent, { kind: "codex" }>,
  cwd: string,
  env: Record<string, string>,
) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(config.baseUrl),
      catch: () => new AgentError({ code: "config", message: "invalid base URL" }),
    });
    if (url.protocol !== "https:")
      return yield* new AgentError({ code: "config", message: "invalid provider settings" });
    const fs = yield* FileSystem.FileSystem;
    const home = codexHome();
    yield* fs
      .makeDirectory(home, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(
          () => new AgentError({ code: "config", message: "could not create Codex home" }),
        ),
      );
    yield* fs
      .writeFileString(
        `${home}/config.toml`,
        `model = ${toml(config.model)}\nmodel_provider = "scotty-managed"\nmodel_reasoning_effort = ${toml(config.effort)}\n[features]\nplugins = false\n[analytics]\nenabled = false\n[model_providers.scotty-managed]\nname = "Scotty managed Codex"\nbase_url = ${toml(config.baseUrl)}\nwire_api = "responses"\nexperimental_bearer_token = ${toml(config.token)}\nhttp_headers = { "chatgpt-account-id" = ${toml(config.accountId)} }\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`,
        { mode: 0o600 },
      )
      .pipe(
        Effect.mapError(
          () => new AgentError({ code: "config", message: "could not write Codex config" }),
        ),
      );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .spawn(
        ChildProcess.make("codex", ["app-server", "--listen", "stdio://"], {
          cwd,
          extendEnv: false,
          forceKillAfter: "2 seconds",
          stdin: { stream: "pipe", endOnDone: false },
          env: {
            ...env,
            PATH: processEnv("PATH"),
            HOME: processEnv("HOME") || "/home/scotty",
            CODEX_HOME: home,
            LANG: "C.UTF-8",
            TERM: "xterm-256color",
          },
        }),
      )
      .pipe(
        Effect.mapError(() => new AgentError({ code: "spawn", message: "could not launch Codex" })),
      );
  });
