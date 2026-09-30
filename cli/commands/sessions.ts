import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { maxSearch } from "../../src/session/view.js";
import { Conversation, Created, List, Log, Settings, View } from "../client.js";
import {
  ago,
  bold,
  dim,
  green,
  launch,
  output,
  sessionIds,
  sessionPath,
  short,
  state,
  table,
  usage,
  withClient,
} from "./common.js";

const repoName = (input: string) =>
  Effect.gen(function* () {
    const value = input.startsWith("https://github.com/")
      ? input
          .slice(19)
          .replace(/\.git$/, "")
          .replace(/\/$/, "")
      : input;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
      return yield* usage("Expected owner/repo or https://github.com/owner/repo", "new");
    return value;
  });

// The first line of the prompt, cut at a word near 60 characters.
const titleFrom = (prompt: string) => {
  const line = prompt.trim().split("\n")[0] ?? "";
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
};

export const create = Command.make(
  "new",
  {
    repository: Argument.String("repo"),
    prompt: Argument.String("prompt"),
    agent: Flag.Literals("agent", ["codex", "claude"]).pipe(Flag.withDefault("codex")),
    key: Flag.String("key").pipe(Flag.optional),
    sessionKey: Flag.String("session-key").pipe(Flag.optional),
  },
  ({ repository, prompt, agent, key, sessionKey }) =>
    Effect.gen(function* () {
      const repo = yield* repoName(repository);
      if (!prompt.trim()) return yield* usage("The prompt cannot be empty", "new");
      const api = yield* withClient;
      const created = yield* api("/api/sessions", Created, {
        method: "POST",
        body: {
          repo,
          title: titleFrom(prompt),
          prompt,
          provider: "cloudflare",
          agent,
          ...(Option.isSome(sessionKey) ? { key: sessionKey.value } : {}),
        },
        ...(Option.isSome(key) ? { key: key.value } : {}),
      });
      const url = new URL(created.url, api.url).href;
      yield* output(
        { ...created, url },
        [
          created.steered === true
            ? `${green("✓")} Sent the prompt to ${bold(created.title)} ${dim("(that key has a session)")}`
            : `${green("✓")} Started ${bold(created.title)} on ${repo} ${dim(`(${agent})`)}`,
          `  ${short(created.id)}  ${url}`,
          dim(`  Follow it: scotty read ${short(created.id)}`),
        ].join("\n"),
      );
    }),
);

export const ls = Command.make(
  "ls",
  {
    what: Argument.Literals("what", ["skills"]).pipe(Argument.optional),
    search: Flag.String("search").pipe(Flag.optional),
  },
  ({ what, search }) =>
    Effect.gen(function* () {
      const api = yield* withClient;
      if (Option.isSome(what)) {
        const settings = yield* api("/api/settings", Settings);
        const lines = settings.instructions.trim().split("\n").length;
        return yield* output(
          settings,
          [
            settings.skills.length === 0
              ? `No skills yet. Add one: scotty push skill ./my-skill`
              : table([
                  ["NAME", "ON", "DESCRIPTION"],
                  ...settings.skills.map((skill) => [
                    skill.name,
                    skill.enabled ? "yes" : "no",
                    skill.description,
                  ]),
                ]),
            dim(
              settings.instructions.trim() === ""
                ? "No instructions. Set them: scotty push instructions ./AGENTS.md"
                : `Instructions: ${lines} line${lines === 1 ? "" : "s"}`,
            ),
          ].join("\n"),
        );
      }
      if (Option.isSome(search) && search.value.trim().length > maxSearch)
        return yield* usage(`--search is at most ${maxSearch} characters`, "ls");
      const query = Option.isSome(search) ? `?q=${encodeURIComponent(search.value.trim())}` : "";
      const { sessions } = yield* api(`/api/sessions${query}`, List);
      const sorted = [...sessions].sort((a, b) =>
        b.display.activeAt.localeCompare(a.display.activeAt),
      );
      yield* output(
        { sessions: sorted },
        sorted.length === 0
          ? Option.isSome(search)
            ? `No sessions match "${search.value}".`
            : `No sessions yet. Start one: scotty new owner/repo "What to do"`
          : table([
              ["ID", "STATE", "AGENT", "ACTIVE", "REPOSITORY", "TITLE"],
              ...sorted.map((session) => [
                short(session.identity.id),
                state(session),
                session.display.agentKind,
                ago(session.display.activeAt),
                session.display.repository,
                session.display.title,
              ]),
            ]),
      );
    }),
);

export const read = Command.make(
  "read",
  {
    id: Argument.String("id"),
    last: Flag.Int("last").pipe(Flag.withDefault(1)),
    role: Flag.Literals("role", ["user", "assistant"]).pipe(Flag.optional),
  },
  ({ id, last, role }) =>
    Effect.gen(function* () {
      if (last < 1 || last > 500)
        return yield* usage("--last must be an integer from 1 to 500", "read");
      const api = yield* withClient;
      const path = yield* sessionPath(api, id, "read");
      const { session } = yield* api(path, View);
      const { turns } = yield* api(`${path}/conversation`, Conversation);
      const messages = turns
        .flatMap((turn) => [
          { id: `${turn.id}:user`, role: "user", state: turn.state, text: turn.user, files: [] },
          ...(turn.assistant === "" && turn.files.length === 0
            ? []
            : [
                {
                  id: `${turn.id}:assistant`,
                  role: "assistant",
                  state: turn.state,
                  text: turn.assistant,
                  files: turn.files.map(
                    (file) =>
                      `${file.name} (${file.type}, ${file.size} bytes) ${new URL(`${path}/files/${file.id}`, api.url).href}`,
                  ),
                },
              ]),
        ])
        .filter((message) => Option.isNone(role) || message.role === role.value)
        .slice(-last);
      const latest = turns.at(-1);
      yield* output(
        {
          id: session.identity.id,
          authority: session.authority,
          turn: latest ? { id: latest.id, state: latest.state } : null,
          messages,
        },
        [
          `${bold(session.display.title)} ${dim(`· ${session.display.repository} · ${session.display.agentKind} · ${state(session)}`)}`,
          ...messages.flatMap((message) => [
            "",
            message.role === "user" ? bold("you") : bold(session.display.agentKind),
            message.text || dim("(no text)"),
            ...message.files.map((file) => dim(`  📎 ${file}`)),
          ]),
          ...(latest?.state === "streaming" ? ["", dim("… still working")] : []),
        ].join("\n"),
      );
    }),
);

export const log = Command.make("log", { id: Argument.String("id") }, ({ id }) =>
  Effect.gen(function* () {
    const api = yield* withClient;
    const events = yield* api(`${yield* sessionPath(api, id, "log")}/log`, Log);
    yield* output(events, events.map((event) => JSON.stringify(event)).join("\n"));
  }),
);

// Opens the web app, or one session in it, in the default browser.
export const open = Command.make(
  "open",
  { id: Argument.String("id").pipe(Argument.optional) },
  ({ id }) =>
    Effect.gen(function* () {
      const api = yield* withClient;
      const [full] = Option.isSome(id) ? yield* sessionIds(api, [id.value], "open") : [];
      const url = new URL(full === undefined ? "/" : `/s/${full}`, api.url).href;
      yield* launch(url);
      yield* output({ url }, `Opened ${url}`);
    }),
);
