import { isAbsolute, join, relative, resolve } from "node:path";
import { Effect, FileSystem, Result } from "effect";
import { CliError, EXIT } from "./core";
import { secureWrite } from "./dependencies";
import { CliRuntime, ProcessRunner } from "./services";

const SERVICE_NAME = "scotty-runner.service";

export interface RunnerSetupInput {
  readonly codexAuthSource: string;
  readonly host: string;
  readonly image: string;
  readonly name: string;
  readonly root: string;
  readonly sourceBinary: string;
}

export interface RunnerSetupResult {
  readonly binary: string;
  readonly credentials: {
    readonly codexAuth: string;
    readonly githubConfig: string;
  };
  readonly environmentFile: string;
  readonly runner: string;
  readonly service: string;
  readonly status: "active";
}

const setupFailure = (message: string, hint: string): CliError =>
  new CliError("runner_setup_failed", message, hint, EXIT.GENERIC);

const systemdQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

const containsPath = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const requireSafePath = Effect.fnUntraced(function* (
  path: string,
  expected: "directory" | "executable" | "private-file",
) {
  if (path.includes("\n") || path.includes("\r") || path.includes("\0")) {
    return yield* setupFailure(
      "Runner setup path is unsafe",
      "Use absolute paths without control characters.",
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const result = yield* Effect.result(fs.stat(path));
  if (expected === "directory") {
    if (Result.isSuccess(result) && result.success.type !== "Directory") {
      return yield* setupFailure(
        "Runner root is not a directory",
        "Choose an absent path or an existing directory.",
      );
    }
    return;
  }
  if (Result.isFailure(result) || result.success.type !== "File") {
    return yield* setupFailure(
      expected === "executable"
        ? "Scotty source binary is missing"
        : "Codex auth source is missing",
      "Pass an existing regular file.",
    );
  }
  if (expected === "executable" && (result.success.mode & 0o111) === 0) {
    return yield* setupFailure(
      "Scotty source binary is not executable",
      "Pass the current compiled Scotty executable.",
    );
  }
  if (expected === "private-file" && (result.success.mode & 0o077) !== 0) {
    return yield* setupFailure(
      "Codex auth source permissions are unsafe",
      "Restrict the source to the current user before retrying.",
    );
  }
});

const requireCommand = Effect.fnUntraced(function* (
  command: ReadonlyArray<string>,
  message: string,
  hint: string,
) {
  const processRunner = yield* ProcessRunner;
  const result = yield* processRunner.run(command);
  if (result.exitCode !== 0) return yield* setupFailure(message, hint);
  return result;
});

export const setupRunner = Effect.fnUntraced(function* (input: RunnerSetupInput) {
  const runtime = yield* CliRuntime;
  const fs = yield* FileSystem.FileSystem;
  const token = runtime.env.SCOTTY_RUNNER_TOKEN?.trim();
  if (!token) {
    return yield* setupFailure(
      "Runner token is not configured",
      "Set SCOTTY_RUNNER_TOKEN in the setup process environment.",
    );
  }
  if (
    token.includes("\n") ||
    token.includes("\r") ||
    input.host.includes("\n") ||
    input.host.includes("\r")
  ) {
    return yield* setupFailure(
      "Runner setup environment is unsafe",
      "Use single-line host and runner token values.",
    );
  }

  const root = resolve(input.root);
  const home = resolve(runtime.home);
  if (
    root === "/" ||
    containsPath(root, home) ||
    containsPath(root, resolve(input.codexAuthSource)) ||
    containsPath(root, resolve(input.sourceBinary))
  ) {
    return yield* setupFailure(
      "Runner root is unsafe",
      "Use a dedicated absolute directory that contains no credentials, binaries, or home directory.",
    );
  }
  yield* requireSafePath(input.codexAuthSource, "private-file");
  yield* requireSafePath(input.sourceBinary, "executable");
  yield* requireSafePath(input.root, "directory");
  yield* requireCommand(
    ["docker", "info", "--format", "{{.ServerVersion}}"],
    "Docker is not available",
    "Install Docker and ensure the current user can reach the daemon.",
  );
  const githubTokenResult = yield* requireCommand(
    ["gh", "auth", "token"],
    "GitHub CLI is not authenticated",
    "Run gh auth login as the runner user, then retry.",
  );
  const githubToken = githubTokenResult.stdout.trim();
  if (githubToken.length === 0 || githubToken.includes("\n") || githubToken.includes("\r")) {
    return yield* setupFailure(
      "GitHub CLI returned an invalid token",
      "Run gh auth login as the runner user, then retry.",
    );
  }
  const githubLoginResult = yield* requireCommand(
    ["gh", "api", "user", "--jq", ".login"],
    "GitHub CLI could not resolve the active user",
    "Run gh auth login as the runner user, then retry.",
  );
  const githubLogin = githubLoginResult.stdout.trim();
  if (githubLogin.length === 0 || githubLogin.includes("\n") || githubLogin.includes("\r")) {
    return yield* setupFailure(
      "GitHub CLI returned an invalid user",
      "Run gh auth login as the runner user, then retry.",
    );
  }

  const binaryDirectory = join(runtime.home, ".local", "bin");
  const binary = join(binaryDirectory, "scotty");
  const credentialDirectory = join(
    runtime.home,
    ".local",
    "share",
    "scotty",
    "runner",
    "credentials",
  );
  const codexAuth = join(credentialDirectory, "codex-auth.json");
  const githubConfig = join(credentialDirectory, "github-hosts.yml");
  const configDirectory = join(runtime.home, ".config", "scotty", "runner");
  const environmentFile = join(configDirectory, "runner.env");
  const systemdDirectory = join(runtime.home, ".config", "systemd", "user");
  const service = join(systemdDirectory, SERVICE_NAME);
  for (const directory of [
    binaryDirectory,
    credentialDirectory,
    configDirectory,
    systemdDirectory,
    root,
  ]) {
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fs.chmod(directory, 0o700)),
      Effect.mapError(() =>
        setupFailure(
          "Could not create runner directories",
          "Check runner-user ownership and path permissions.",
        ),
      ),
    );
  }

  if (resolve(input.sourceBinary) !== resolve(binary)) {
    const stagedBinary = `${binary}.new`;
    yield* fs.remove(stagedBinary, { force: true }).pipe(
      Effect.andThen(fs.copyFile(input.sourceBinary, stagedBinary)),
      Effect.andThen(fs.chmod(stagedBinary, 0o755)),
      Effect.andThen(fs.rename(stagedBinary, binary)),
      Effect.ensuring(Effect.ignore(fs.remove(stagedBinary, { force: true }))),
      Effect.mapError(() =>
        setupFailure(
          "Could not install the Scotty executable",
          "Check the source binary and ~/.local/bin permissions.",
        ),
      ),
    );
  }
  yield* fs
    .chmod(binary, 0o755)
    .pipe(
      Effect.mapError(() =>
        setupFailure(
          "Could not secure the Scotty executable",
          "Check ~/.local/bin ownership and permissions.",
        ),
      ),
    );
  yield* fs.copyFile(input.codexAuthSource, codexAuth).pipe(
    Effect.andThen(fs.chmod(codexAuth, 0o600)),
    Effect.mapError(() =>
      setupFailure(
        "Could not install Codex authentication",
        "Check runner credential directory ownership and permissions.",
      ),
    ),
  );
  yield* secureWrite(
    githubConfig,
    `github.com:\n  git_protocol: https\n  oauth_token: ${JSON.stringify(githubToken)}\n  user: ${JSON.stringify(githubLogin)}\n`,
  );
  yield* secureWrite(environmentFile, `SCOTTY_RUNNER_TOKEN=${JSON.stringify(token)}\n`);

  const execStart = [
    binary,
    "runner",
    "serve",
    "--host",
    input.host,
    "--name",
    input.name,
    "--root",
    root,
    "--isolation",
    "docker",
    "--image",
    input.image,
    "--codex-auth",
    codexAuth,
    "--github-config",
    githubConfig,
  ]
    .map(systemdQuote)
    .join(" ");
  yield* secureWrite(
    service,
    `[Unit]
Description=Scotty trusted runner
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=simple
EnvironmentFile=${environmentFile}
ExecStart=${execStart}
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=read-only
ProtectSystem=strict
ReadWritePaths=${root}

[Install]
WantedBy=default.target
`,
  );

  yield* requireCommand(
    ["systemctl", "--user", "daemon-reload"],
    "Could not reload the systemd user manager",
    "Ensure the runner user has an active systemd user manager.",
  );
  yield* requireCommand(
    ["systemctl", "--user", "enable", SERVICE_NAME],
    "Could not enable the Scotty runner service",
    `Inspect systemctl --user status ${SERVICE_NAME}.`,
  );
  yield* requireCommand(
    ["systemctl", "--user", "restart", SERVICE_NAME],
    "Could not restart the Scotty runner service",
    `Inspect systemctl --user status ${SERVICE_NAME}.`,
  );
  const active = yield* requireCommand(
    ["systemctl", "--user", "is-active", SERVICE_NAME],
    "Scotty runner service is not active",
    `Inspect journalctl --user -u ${SERVICE_NAME}.`,
  );
  if (active.stdout.trim() !== "active") {
    return yield* setupFailure(
      "Scotty runner service is not active",
      `Inspect journalctl --user -u ${SERVICE_NAME}.`,
    );
  }

  return {
    binary,
    credentials: { codexAuth, githubConfig },
    environmentFile,
    runner: input.name,
    service,
    status: "active",
  } satisfies RunnerSetupResult;
});
