import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { Config } from "../../runner.js";
import { AgentError } from "../../runner.js";
import { keepsDisk, notTmpfs, onTmpfs } from "../../place.js";
import { processEnv, runDir } from "../../runtime.js";

// JSON basic-string escapes also satisfy TOML except for DEL (U+007F).
// The agent schema rejects lone surrogates in every string written to this config.
export const toml = (value: string) => JSON.stringify(value).replace(/\u007f/g, "\\u007f");
// What Scotty saves and installs: rollouts and instructions, on the disk.
export const codexHome = () => processEnv("SCOTTY_CODEX_HOME") || "/home/scotty/.codex";
// Where a place keeps the disk, Codex's CODEX_HOME is on the tmpfs, so config.toml with the
// access token, and anything Codex rewrites beside it, never rests on a paused disk. Its sessions
// and instructions link back to codexHome, so rollouts stay on the disk. On Cloudflare the disk
// goes with the container, and CODEX_HOME is codexHome itself.
const runtimeHome = `${runDir}/codex`;
const kept = ["sessions", "AGENTS.md"];

const writeConfig = (config: Extract<Config, { kind: "codex"; token: string }>, home: string) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(config.baseUrl),
      catch: () => new AgentError({ code: "config", message: "invalid base URL" }),
    });
    if (url.protocol !== "https:")
      return yield* new AgentError({ code: "config", message: "invalid provider settings" });
    if (keepsDisk() && !(yield* onTmpfs))
      return yield* new AgentError({ code: "config", message: notTmpfs });
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .writeFileString(
        `${home}/config.toml`,
        `model = ${toml(config.model)}\nmodel_provider = "scotty-managed"\nmodel_reasoning_effort = ${toml(config.effort)}\n[features]\nplugins = false\n[analytics]\nenabled = false\n[model_providers.scotty-managed]\nname = "Scotty managed Codex"\nbase_url = ${toml(config.baseUrl)}\nwire_api = "responses"\nexperimental_bearer_token = ${toml(config.token)}\nhttp_headers = { "chatgpt-account-id" = ${toml(config.accountId)} }\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n` +
          (config.mcp ?? [])
            .map((server) => `\n[mcp_servers.${toml(server.name)}]\nurl = ${toml(server.url)}\n`)
            .join("") +
          // Owner-switched-off skills are installed (other skills link into them) but hidden.
          (config.skillsOff ?? [])
            .map((name) => `\n[[skills.config]]\nname = ${toml(name)}\nenabled = false\n`)
            .join(""),
        { mode: 0o600 },
      )
      .pipe(
        Effect.mapError(
          () => new AgentError({ code: "config", message: "could not write Codex config" }),
        ),
      );
  });

export const launchCodex = (
  config: Extract<Config, { kind: "codex" }>,
  cwd: string,
  env: Record<string, string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = keepsDisk() ? runtimeHome : codexHome();
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
      if (home === codexHome()) return;
      yield* fs.makeDirectory(`${codexHome()}/sessions`, { recursive: true, mode: 0o700 });
      for (const name of kept) {
        yield* fs.remove(`${home}/${name}`, { force: true });
        yield* fs.symlink(`${codexHome()}/${name}`, `${home}/${name}`);
      }
    }).pipe(
      Effect.mapError(
        () => new AgentError({ code: "config", message: "could not create Codex home" }),
      ),
    );
    if (!("scripted" in config)) yield* writeConfig(config, home);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .spawn(
        ChildProcess.make(
          "scripted" in config ? "scotty-codex-scripted" : "codex",
          ["app-server", "--listen", "stdio://"],
          {
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
          },
        ),
      )
      .pipe(
        Effect.mapError(() => new AgentError({ code: "spawn", message: "could not launch Codex" })),
      );
  });
