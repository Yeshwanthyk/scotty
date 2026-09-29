import { Effect, Exit, Option, Schema, Stream } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { BunServices } from "@effect/platform-bun";
import { version } from "../../src/version.js";
import {
  ChatGptStatus,
  ClaudeStatus,
  GitHubStatus,
  List,
  Polled,
  Started,
  CliFailure,
  access,
  client,
  failure,
} from "../client.js";
import {
  type Api,
  address,
  bold,
  dim,
  green,
  launch,
  output,
  readStdin,
  red,
  withClient,
  yellow,
} from "./common.js";

const Version = Schema.Struct({ version: Schema.String });

type Check = {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail" | "skip";
  readonly detail: string;
  readonly fix?: string;
};

const until = (at: number | null) => {
  if (at === null) return "";
  const days = Math.floor((at - Date.now()) / 86_400_000);
  return days >= 2
    ? ` · ${days} days left`
    : ` · ${Math.max(0, Math.round((at - Date.now()) / 3_600_000))}h left`;
};

const fail = (name: string, detail: string, fix: string): Check => ({
  name,
  status: "fail",
  detail,
  fix,
});

// A failed check reports the failure's own message and fix.
const failed = (name: string, exit: Exit.Failure<unknown, CliFailure>, fix: string): Check => {
  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  return fail(name, error?.message ?? "failed", error?.hint ?? fix);
};

// Every check runs, so one run shows everything left to do.
const checks = Effect.gen(function* () {
  const found = yield* Effect.exit(address);
  if (Exit.isFailure(found)) return [failed("Setup", found, "scotty init")];
  const url = found.value;
  const token = yield* Effect.exit(access(url));
  if (Exit.isFailure(token)) return [failed("Access", token, `cloudflared access login ${url}`)];
  const api = client({ url, token: token.value });
  const result: Check[] = [{ name: "Access", status: "ok", detail: "signed in" }];
  const worker = yield* Effect.exit(
    Effect.all([api("/api/version", Version), api("/api/sessions", List)]),
  );
  // Any Worker failure, a 404 from an older deploy included, is fixed by deploying.
  if (Exit.isFailure(worker)) {
    const error = Option.getOrUndefined(Exit.findErrorOption(worker));
    return [...result, fail("Worker", error?.message ?? "no answer", "scotty deploy")];
  }
  const [deployed, { sessions }] = worker.value;
  result.push(
    deployed.version === version
      ? {
          name: "Worker",
          status: "ok",
          detail: `v${version} · ${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
        }
      : {
          name: "Worker",
          status: "warn",
          detail: `v${deployed.version} deployed, this CLI is v${version}`,
          fix: "scotty deploy",
        },
  );
  const chatgpt = yield* Effect.exit(api("/api/credentials/chatgpt", ChatGptStatus));
  result.push(
    Exit.isFailure(chatgpt)
      ? failed("ChatGPT", chatgpt, "scotty doctor")
      : chatgpt.value.status === "signed-out"
        ? fail("ChatGPT", "not signed in", "scotty login chatgpt")
        : expiring("ChatGPT", "signed in", chatgpt.value, "scotty login chatgpt"),
  );
  const github = yield* Effect.exit(api("/api/credentials/github", GitHubStatus));
  result.push(
    Exit.isFailure(github)
      ? failed("GitHub", github, "scotty doctor")
      : github.value.status === "set"
        ? { name: "GitHub", status: "ok", detail: `token for ${github.value.login ?? "unknown"}` }
        : fail("GitHub", "no token", "scotty login github"),
  );
  // Claude is optional: Codex sessions don't need it.
  const claude = yield* Effect.exit(api("/api/credentials/claude", ClaudeStatus));
  result.push(
    Exit.isFailure(claude)
      ? failed("Claude", claude, "scotty doctor")
      : claude.value.status === "signed-out"
        ? {
            name: "Claude",
            status: "skip",
            detail: "not set (optional)",
            fix: "scotty login claude",
          }
        : expiring("Claude", "token set", claude.value, "scotty login claude"),
  );
  return result;
});

const expiring = (
  name: string,
  detail: string,
  status: typeof ChatGptStatus.Type,
  fix: string,
): Check =>
  status.status === "expiring"
    ? { name, status: "warn", detail: `${detail}${until(status.expiresAt)}`, fix }
    : { name, status: "ok", detail: `${detail}${until(status.expiresAt)}` };

const mark = { ok: green("✓"), warn: yellow("!"), fail: red("✗"), skip: dim("–") };

export const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const result = yield* checks;
    const ok = result.every((check) => check.status !== "fail");
    const width = Math.max(...result.map((check) => check.name.length));
    yield* output(
      { ok, version, checks: result },
      [
        ...result.map(
          (check) =>
            `${mark[check.status]} ${check.name.padEnd(width)}  ${check.detail}${check.fix ? dim(`  → ${check.fix}`) : ""}`,
        ),
        "",
        ok
          ? `${green("Ready.")} Start a session: scotty new owner/repo "What to do"`
          : `Fix the ${red("✗")} items above, then run scotty doctor again.`,
      ].join("\n"),
    );
    if (!ok) process.exitCode = 3;
  }),
);

const run = (command: string, args: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" }),
    );
    const text = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
    return (yield* child.exitCode) === 0 ? text.trim() : "";
  }).pipe(
    Effect.scoped,
    Effect.provide(BunServices.layer),
    Effect.orElseSucceed(() => ""),
  );

// Piped stdin wins; otherwise the token comes from `gh auth token`.
const loginGitHub = (api: Api) =>
  Effect.gen(function* () {
    const piped = process.stdin.isTTY ? "" : (yield* readStdin).trim();
    const token = piped === "" ? yield* run("gh", ["auth", "token"]) : piped;
    if (token === "")
      return yield* failure(
        "signin",
        "No GitHub token: gh is not signed in and nothing was piped",
        "gh auth login, then scotty login github",
        3,
      );
    const saved = yield* api("/api/credentials/github", GitHubStatus, {
      method: "POST",
      body: { token },
    });
    yield* output(
      saved,
      `${green("✓")} GitHub token saved ${dim(`(${saved.login ?? "unknown"})`)}`,
    );
  });

// Colour and cursor codes, and OSC links ended by BEL or ESC \.
// oxlint-disable-next-line no-control-regex
const ansi = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g;

// A line of URL characters only: the rest of a sign-in link wrapped at the terminal width.
const urlRest = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
// The token, with the rest of it on following lines if the output wrapped.
const tokenPattern = /sk-ant-oat01-[A-Za-z0-9_-]+(?:\r?\n[ \t]*[A-Za-z0-9_-]+[ \t]*(?=\r?\n|$))*/;

// `claude setup-token` redraws its screen. Only the sign-in link and prompts are shown, each once;
// nothing else is, so no part of the token can be. A line that follows the token is never shown.
const loginClaude = (api: Api) =>
  Effect.gen(function* () {
    const shown = new Set<string>();
    let partial = "";
    let inLink = false;
    const show = (raw: string) => {
      const line = raw.replace(ansi, "").trim();
      const visible =
        !line.includes("sk-ant-") &&
        (/https?:\/\/|paste|browser/i.test(line) || (inLink && urlRest.test(line)));
      inLink = visible && (/https?:\/\//.test(line) || inLink) && line !== "";
      if (!visible || shown.has(line)) return;
      shown.add(line);
      process.stderr.write(`${line}\n`);
    };
    const fromClaude = Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make("claude", ["setup-token"], { stdin: "inherit", stderr: "inherit" }),
        );
        const printed = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.tap((text) =>
            Effect.sync(() => {
              const lines = (partial + text).split(/\r?\n|\r/);
              partial = lines.pop() ?? "";
              lines.forEach(show);
            }),
          ),
          Stream.mkString,
        );
        yield* child.exitCode;
        show(partial);
        return tokenPattern.exec(printed.replace(ansi, ""))?.[0].replace(/\s/g, "");
      }),
    ).pipe(
      Effect.provide(BunServices.layer),
      Effect.mapError(() =>
        failure(
          "signin",
          "Could not run claude setup-token",
          "Install Claude Code, or pipe the token: scotty login claude < file",
          3,
        ),
      ),
    );
    const token = process.stdin.isTTY ? yield* fromClaude : (yield* readStdin).trim();
    // A token cut short (by a wrapped line) would be saved and fail only at session start.
    if (token === undefined || !/^sk-ant-oat01-[A-Za-z0-9_-]{80,}$/.test(token))
      return yield* failure(
        "signin",
        "No Claude token found",
        "Run scotty login claude again, or pipe the token: scotty login claude < file",
        3,
      );
    const saved = yield* api("/api/credentials/claude", ClaudeStatus, {
      method: "POST",
      body: { token },
    });
    yield* output(saved, `${green("✓")} Claude token saved${dim(until(saved.expiresAt))}`);
  });

// Device-code sign-in: the browser opens on the page, the code is printed to type in.
const loginChatGpt = (api: Api) =>
  Effect.gen(function* () {
    const start = yield* api("/api/credentials/chatgpt/start", Started, { method: "POST" });
    if ("status" in start)
      return yield* failure(
        "signin",
        `ChatGPT sign-in failed: ${start.code ?? start.stage}`,
        "scotty login chatgpt",
      );
    console.error(`Enter this code at ${start.verificationUrl}\n\n    ${bold(start.userCode)}\n`);
    if (process.stdout.isTTY) yield* Effect.ignore(launch(start.verificationUrl));
    while (Date.now() < start.expiresAt) {
      yield* Effect.sleep(`${Math.max(1, start.interval)} seconds`);
      const result = yield* api("/api/credentials/chatgpt/poll", Polled, { method: "POST" });
      if (result.status === "pending") continue;
      if (result.status === "signed-in")
        return yield* output(
          result,
          `${green("✓")} ChatGPT signed in${dim(until(result.expiresAt))}`,
        );
      return yield* failure(
        "signin",
        result.status === "expired"
          ? "The code expired"
          : `ChatGPT sign-in failed: ${result.code ?? result.stage}`,
        "scotty login chatgpt",
        3,
      );
    }
    return yield* failure("signin", "The code expired", "scotty login chatgpt", 3);
  });

const loginTo = (account: "chatgpt" | "github" | "claude") =>
  Effect.gen(function* () {
    const api = yield* withClient;
    return yield* account === "chatgpt"
      ? loginChatGpt(api)
      : account === "claude"
        ? loginClaude(api)
        : loginGitHub(api);
  });

export const login = Command.make(
  "login",
  { account: Argument.Literals("account", ["chatgpt", "github", "claude"]) },
  ({ account }) => loginTo(account),
);
