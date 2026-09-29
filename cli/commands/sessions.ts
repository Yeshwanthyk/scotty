import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Conversation, Created, List, Log, View } from "../client.js";
import { output, sessionPath, url, usage, withClient } from "./common.js";

const id = Argument.String("id");
const repository = Argument.String("owner/repo");
const repoName = (input: string) => {
  const value = input.startsWith("https://github.com/")
    ? input
        .slice(19)
        .replace(/\.git$/, "")
        .replace(/\/$/, "")
    : input;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
    throw usage("Expected owner/repo or https://github.com/owner/repo", "new");
  return value;
};
export const create = Command.make(
  "new",
  {
    url,
    repository,
    prompt: Flag.String("prompt").pipe(Flag.optional),
    key: Flag.String("key").pipe(Flag.optional),
    agent: Flag.Literals("agent", ["codex", "claude"]).pipe(Flag.withDefault("codex")),
  },
  ({ url: target, repository: input, prompt, key, agent }) =>
    Effect.gen(function* () {
      const repo = repoName(input);
      const api = yield* withClient(target);
      const body = {
        repo,
        title: repo,
        prompt: Option.getOrElse(prompt, () => "Inspect this repository and report what you find."),
        provider: "cloudflare",
        agent,
      };
      return yield* output(
        yield* api("/api/sessions", Created, {
          method: "POST",
          body,
          ...(Option.isSome(key) ? { key: key.value } : {}),
        }),
      );
    }),
).pipe(Command.withDescription("Create a session on a GitHub repository"));

export const ls = Command.make("ls", { url }, ({ url: target }) =>
  Effect.gen(function* () {
    const api = yield* withClient(target);
    return yield* output(yield* api("/api/sessions", List));
  }),
).pipe(Command.withDescription("List sessions"));

export const show = Command.make("show", { url, id }, ({ url: target, id: value }) =>
  Effect.gen(function* () {
    const path = sessionPath(value);
    const api = yield* withClient(target);
    const view = yield* api(path, View);
    const conversation = yield* api(`${path}/conversation`, Conversation);
    return yield* output({ ...view, turns: conversation.turns });
  }),
).pipe(Command.withDescription("Show a session view and its conversation turns"));

export const log = Command.make("log", { url, id }, ({ url: target, id: value }) =>
  Effect.gen(function* () {
    const path = sessionPath(value);
    const api = yield* withClient(target);
    return yield* output(yield* api(`${path}/log`, Log));
  }),
).pipe(Command.withDescription("Show raw session events"));
