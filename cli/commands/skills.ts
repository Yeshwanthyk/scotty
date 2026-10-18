import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Settings, SkillSwitched, SourceRemoved, SourceSaved, StyleSet } from "../client.js";
import { ago, bold, dim, green, output, table, usage, withClient } from "./common.js";

const changes = (saved: typeof SourceSaved.Type) => {
  const parts = [
    saved.added.length > 0 ? `${saved.added.length} new (off): ${saved.added.join(", ")}` : "",
    saved.updated.length > 0 ? `updated: ${saved.updated.join(", ")}` : "",
    saved.removed.length > 0 ? `gone: ${saved.removed.join(", ")}` : "",
  ].filter((part) => part !== "");
  return [
    `${green("✓")} ${bold(saved.source)} at ${saved.commit.slice(0, 7)}${parts.length === 0 ? dim(" · no changes") : ""}`,
    ...parts.map((part) => `  ${part}`),
    ...saved.skipped.map((reason) => dim(`  skipped ${reason}`)),
  ].join("\n");
};

const list = Command.make("ls", {}, () =>
  Effect.gen(function* () {
    const api = yield* withClient;
    const settings = yield* api("/api/settings", Settings);
    const lines = settings.instructions.trim().split("\n").length;
    yield* output(
      settings,
      [
        ...(settings.sources.length === 0
          ? ["No skills yet. Add a repository's: scotty skills add owner/repo/skills"]
          : settings.sources.map((source) =>
              [
                `${bold(source.id)}${source.ref === null ? "" : `@${source.ref}`}  ${dim(`${source.skills.filter((skill) => skill.enabled).length} of ${source.skills.length} on · ${source.commit.slice(0, 7)} · fetched ${ago(new Date(source.fetched).toISOString())}`)}`,
                table(
                  source.skills.map((skill) => [
                    `  ${skill.enabled ? green("on ") : dim("off")}`,
                    skill.name,
                    `${skill.manual ? "manual · " : ""}${skill.description.split("\n")[0] ?? ""}`,
                  ]),
                ),
              ].join("\n"),
            )),
        dim(
          settings.claudeStyle === null
            ? "No Claude output style. Set one: scotty skills style <name>"
            : `Claude output style: ${settings.claudeStyle}`,
        ),
        dim(
          settings.instructions.trim() === ""
            ? "No instructions. Set them: scotty push instructions ./AGENTS.md"
            : `Instructions: ${lines} line${lines === 1 ? "" : "s"}`,
        ),
      ].join("\n"),
    );
  }),
);

const add = Command.make("add", { source: Argument.String("source") }, ({ source }) =>
  Effect.gen(function* () {
    const api = yield* withClient;
    const saved = yield* api("/api/skill-sources", SourceSaved, {
      method: "POST",
      body: { source },
    });
    yield* output(saved, `${changes(saved)}\n${dim(`Turn skills on: scotty skills on <name…>`)}`);
  }),
);

// No source refreshes every one.
const refresh = Command.make(
  "refresh",
  { source: Argument.String("source").pipe(Argument.optional) },
  ({ source }) =>
    Effect.gen(function* () {
      const api = yield* withClient;
      const ids = Option.isSome(source)
        ? [source.value]
        : (yield* api("/api/settings", Settings)).sources.map((known) => known.id);
      const saved = yield* Effect.forEach(ids, (id) =>
        api("/api/skill-sources/refresh", SourceSaved, { method: "POST", body: { source: id } }),
      );
      yield* output(
        saved,
        saved.length === 0 ? "No skill sources to refresh" : saved.map(changes).join("\n"),
      );
    }),
);

const remove = Command.make("rm", { source: Argument.String("source") }, ({ source }) =>
  Effect.gen(function* () {
    const api = yield* withClient;
    const removed = yield* api("/api/skill-sources/remove", SourceRemoved, {
      method: "POST",
      body: { source },
    });
    yield* output(removed, `${green("✓")} Removed ${removed.source} and its skills`);
  }),
);

const toggle = (name: "on" | "off") =>
  Command.make(name, { names: Argument.String("name").pipe(Argument.atLeast(1)) }, ({ names }) =>
    Effect.gen(function* () {
      const api = yield* withClient;
      const switched = yield* Effect.forEach(names, (skill) =>
        api(`/api/skills/${encodeURIComponent(skill)}`, SkillSwitched, {
          method: "PATCH",
          body: { enabled: name === "on" },
        }),
      );
      yield* output(
        switched,
        [
          ...switched.map((skill) => `${green("✓")} ${bold(skill.name)} is ${name}`),
          dim("New sessions and resumes get the change."),
        ].join("\n"),
      );
    }),
  );

// Claude sessions run the skill as their output style; setting one switches the skill on.
const style = Command.make(
  "style",
  {
    name: Argument.String("name").pipe(Argument.optional),
    none: Flag.Boolean("none").pipe(Flag.withDefault(false)),
  },
  ({ name, none }) =>
    Effect.gen(function* () {
      if (none === Option.isSome(name))
        return yield* usage("Name a skill or pass --none, not both", "skills style");
      const api = yield* withClient;
      const set = yield* api("/api/settings/claude-style", StyleSet, {
        method: "PUT",
        body: { skill: Option.getOrNull(name) },
      });
      yield* output(
        set,
        [
          set.claudeStyle === null
            ? `${green("✓")} Claude sessions have no output style`
            : `${green("✓")} Claude sessions run ${bold(set.claudeStyle)} as their output style`,
          dim("New sessions and resumes get the change."),
        ].join("\n"),
      );
    }),
);

export const skills = Command.make("skills").pipe(
  Command.withSubcommands([list, add, refresh, remove, toggle("on"), toggle("off"), style]),
);
