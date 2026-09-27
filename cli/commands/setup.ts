import { Effect, Option, Stdio, Stream } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { ChatGptStatus, GitHubStatus, Polled, Started, List, client, failure } from "../client.js";
import { output, url, withClient } from "./common.js";

type Api = ReturnType<typeof client>;
const chatgptHint = "scotty auth login chatgpt";

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
    yield* output({
      url: Option.getOrElse(target, () => process.env.SCOTTY_URL ?? ""),
      access: "ok",
      worker: "ok",
      sessions: reply.sessions.length,
      chatgpt: "ok",
      chatgptExpiresAt: chatgpt.expiresAt,
      github: "ok",
      githubLogin: github.login,
    });
  }),
).pipe(Command.withDescription("Check URL, Access, Worker, ChatGPT sign-in and GitHub"));

const loginGitHub = (api: Api) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const token = (yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)).trim();
    yield* output(
      yield* api("/api/credentials/github", GitHubStatus, { method: "POST", body: { token } }),
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
  { url, account: Argument.Literals("account", ["chatgpt", "github"]) },
  ({ url: target, account }) =>
    Effect.gen(function* () {
      const api = yield* withClient(target);
      return yield* account === "chatgpt" ? loginChatGpt(api) : loginGitHub(api);
    }),
).pipe(Command.withDescription("Sign in to ChatGPT, or store the GitHub token read from stdin"));

const status = Command.make("status", { url }, ({ url: target }) =>
  Effect.gen(function* () {
    const api = yield* withClient(target);
    yield* output({
      chatgpt: yield* api("/api/credentials/chatgpt", ChatGptStatus),
      github: yield* api("/api/credentials/github", GitHubStatus),
    });
  }),
).pipe(Command.withDescription("Show ChatGPT and GitHub credential status"));

export const auth = Command.make("auth").pipe(Command.withSubcommands([login, status]));
