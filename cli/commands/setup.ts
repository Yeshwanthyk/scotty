import { Effect, Option, Stdio, Stream } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  ChatGptStatus,
  ClaudeStatus,
  GitHubStatus,
  Polled,
  Started,
  List,
  client,
  failure,
} from "../client.js";
import { output, url, withClient } from "./common.js";

type Api = ReturnType<typeof client>;
const chatgptHint = "scotty auth login chatgpt";
const claudeHint = "scotty auth login claude";

export const doctor = Command.make("doctor", { url }, ({ url: target }) =>
  Effect.gen(function* () {
    const api = yield* withClient(target);
    const reply = yield* api("/api/sessions", List);
    const chatgpt = yield* api("/api/credentials/chatgpt", ChatGptStatus);
    if (chatgpt.status !== "signed-in")
      return yield* failure(
        "setup",
        chatgpt.status === "expiring"
          ? "ChatGPT sign-in expires within a day"
          : "ChatGPT is not signed in",
        chatgptHint,
        3,
      );
    const github = yield* api("/api/credentials/github", GitHubStatus);
    if (github.status !== "set")
      return yield* failure("setup", "GitHub token is not set", "scotty auth login github", 3);
    // Claude is optional: Codex sessions don't need it.
    const claude = yield* api("/api/credentials/claude", ClaudeStatus);
    if (claude.status === "expiring")
      console.error(`Claude token expires within 14 days; run ${claudeHint}`);
    yield* output({
      url: Option.getOrElse(target, () => process.env.SCOTTY_URL ?? ""),
      access: "ok",
      worker: "ok",
      sessions: reply.sessions.length,
      chatgpt: "ok",
      chatgptExpiresAt: chatgpt.expiresAt,
      github: "ok",
      githubLogin: github.login,
      claude:
        claude.status === "signed-out"
          ? "missing"
          : claude.status === "expiring"
            ? "expiring"
            : "ok",
      claudeExpiresAt: claude.expiresAt,
    });
  }),
).pipe(Command.withDescription("Check URL, Access, Worker, ChatGPT, GitHub and Claude"));

const loginGitHub = (api: Api) =>
  Effect.gen(function* () {
    const token = yield* readStdin;
    yield* output(
      yield* api("/api/credentials/github", GitHubStatus, { method: "POST", body: { token } }),
    );
  });

const readStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  return (yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)).trim();
});

// From a terminal, runs `claude setup-token` (the owner signs in to claude.ai in the browser)
// and takes the token it prints; otherwise reads the token from stdin.
const loginClaude = (api: Api) =>
  Effect.gen(function* () {
    const fromClaude = Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make("claude", ["setup-token"], { stdin: "inherit", stderr: "inherit" }),
        );
        const printed = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.tap((text) => Effect.sync(() => process.stderr.write(text))),
          Stream.mkString,
        );
        yield* child.exitCode;
        // Colour codes around the token stop the match; they are not part of it.
        return /sk-ant-oat01-[A-Za-z0-9_-]+/.exec(printed)?.[0];
      }),
    ).pipe(
      Effect.mapError(() =>
        failure(
          "signin",
          "Could not run claude setup-token",
          "Install Claude Code, or pipe the token: scotty auth login claude < file",
          3,
        ),
      ),
    );
    const token = process.stdin.isTTY ? yield* fromClaude : yield* readStdin;
    if (token === undefined || token === "")
      return yield* failure(
        "signin",
        "No token found in claude setup-token output",
        "Paste it in Settings, or pipe it: scotty auth login claude < file",
        3,
      );
    yield* output(
      yield* api("/api/credentials/claude", ClaudeStatus, { method: "POST", body: { token } }),
    );
  });

const loginChatGpt = (api: Api) =>
  Effect.gen(function* () {
    const start = yield* api("/api/credentials/chatgpt/start", Started, { method: "POST" });
    if ("status" in start)
      return yield* failure(
        "signin",
        `ChatGPT sign-in failed: ${start.code ?? start.stage}`,
        chatgptHint,
      );
    console.error(`Open ${start.verificationUrl} and enter code ${start.userCode}`);
    const expires = start.expiresAt;
    while (Date.now() < expires) {
      yield* Effect.sleep(`${Math.max(1, start.interval)} seconds`);
      const result = yield* api("/api/credentials/chatgpt/poll", Polled, { method: "POST" });
      if (result.status === "pending") continue;
      if (result.status === "signed-in") return yield* output(result);
      return yield* failure(
        "signin",
        result.status === "expired"
          ? "Device code expired"
          : `ChatGPT sign-in failed: ${result.code ?? result.stage}`,
        chatgptHint,
        3,
      );
    }
    return yield* failure("signin", "Device code expired", chatgptHint, 3);
  });

const login = Command.make(
  "login",
  { url, account: Argument.Literals("account", ["chatgpt", "github", "claude"]) },
  ({ url: target, account }) =>
    Effect.gen(function* () {
      const api = yield* withClient(target);
      return yield* account === "chatgpt"
        ? loginChatGpt(api)
        : account === "claude"
          ? loginClaude(api)
          : loginGitHub(api);
    }),
).pipe(
  Command.withDescription(
    "Sign in to ChatGPT, store the Claude setup token, or store the GitHub token read from stdin",
  ),
);

const status = Command.make("status", { url }, ({ url: target }) =>
  Effect.gen(function* () {
    const api = yield* withClient(target);
    yield* output({
      chatgpt: yield* api("/api/credentials/chatgpt", ChatGptStatus),
      github: yield* api("/api/credentials/github", GitHubStatus),
      claude: yield* api("/api/credentials/claude", ClaudeStatus),
    });
  }),
).pipe(Command.withDescription("Show ChatGPT, GitHub and Claude credential status"));

export const auth = Command.make("auth").pipe(Command.withSubcommands([login, status]));
