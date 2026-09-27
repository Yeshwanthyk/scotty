import { Effect, Option, Stdio, Stream } from "effect";
import { Command } from "effect/unstable/cli";
import { ChatGptStatus, GitHubStatus, Polled, Started, List, failure } from "../client.js";
import { output, url, withClient } from "./common.js";

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
        "npm run --silent scotty -- signin",
        3,
      );
    const github = yield* api("/api/credentials/github", GitHubStatus);
    if (github.status !== "set")
      return yield* failure("setup", "GitHub token is not set", "scotty github set", 3);
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

const set = Command.make("set", { url }, ({ url: target }) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const token = (yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)).trim();
    const api = yield* withClient(target);
    yield* output(
      yield* api("/api/credentials/github", GitHubStatus, { method: "POST", body: { token } }),
    );
  }),
).pipe(Command.withDescription("Store the GitHub token read from stdin"));
export const github = Command.make("github").pipe(Command.withSubcommands([set]));

export const signin = Command.make("signin", { url }, ({ url: target }) =>
  Effect.gen(function* () {
    const api = yield* withClient(target);
    const start = yield* api("/api/credentials/chatgpt/start", Started, { method: "POST" });
    if ("status" in start)
      return yield* failure(
        "signin",
        `ChatGPT sign-in failed: ${start.code ?? start.stage}`,
        "scotty signin",
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
        "scotty signin",
        3,
      );
    }
    return yield* failure("signin", "Device code expired", "scotty signin", 3);
  }),
).pipe(Command.withDescription("Sign in to ChatGPT with a device code"));
