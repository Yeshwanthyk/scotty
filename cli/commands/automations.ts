import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { AutomationRemoved, Automations, AutomationSwitched, RunFired, Runs } from "../client.js";
import { ago, bold, dim, green, output, short, table, usage, withClient } from "./common.js";
import { repoName } from "./sessions.js";
import { automationName, describeFilter, parseFilter } from "../../src/automations/automation.js";

type Automation = (typeof Automations.Type)["automations"][number];

const checkName = (name: string, command: string) =>
  automationName.test(name)
    ? Effect.void
    : usage(
        "A name is lowercase letters, digits and - (at most 40), starting with a letter or digit",
        command,
      );

// One line a person reads: when it fires, what must match, and what it starts.
const sentence = (automation: Automation) => {
  const when =
    automation.when.kind === "calendar"
      ? `At cron ${automation.when.cron} (${automation.when.tz})`
      : automation.when.kind === "interval"
        ? `Every ${automation.when.minutes} minute${automation.when.minutes === 1 ? "" : "s"}`
        : `On each delivery to ${automation.when.connection}`;
  const only = describeFilter(automation.only ?? {});
  const except = describeFilter(automation.except ?? {});
  const line = automation.prompt.trim().split("\n")[0] ?? "";
  return [
    when,
    only.length === 0 ? "" : ` where ${only.join(" and ")}`,
    except.length === 0 ? "" : ` except where ${except.join(" and ")}`,
    `, ${automation.action ?? "start"} (${automation.agent}) on ${automation.repo}`,
    automation.branch === undefined ? "" : ` from ${automation.branch}`,
    automation.key === undefined ? "" : ` (key ${automation.key})`,
    `: ${line.length > 60 ? `${line.slice(0, 60)}…` : line}`,
  ].join("");
};

const lastRun = (automation: Automation) =>
  automation.lastRun === null
    ? "never run"
    : `last run ${automation.lastRun.status}${automation.lastRun.reason === null ? "" : ` (${automation.lastRun.reason})`} ${ago(new Date(automation.lastRun.at).toISOString())}`;

const add = Command.make(
  "add",
  {
    name: Argument.String("name"),
    repository: Argument.String("repo"),
    prompt: Argument.String("prompt"),
    cron: Flag.String("cron").pipe(Flag.optional),
    tz: Flag.String("tz").pipe(Flag.optional),
    every: Flag.Int("every").pipe(Flag.optional),
    on: Flag.String("on").pipe(Flag.optional),
    only: Flag.KeyValuePair("only").pipe(Flag.optional),
    except: Flag.KeyValuePair("except").pipe(Flag.optional),
    branch: Flag.String("branch").pipe(Flag.optional),
    action: Flag.Literals("action", ["start", "wake", "end"]).pipe(Flag.withDefault("start")),
    key: Flag.String("key").pipe(Flag.optional),
    agent: Flag.Literals("agent", ["codex", "claude"]).pipe(Flag.withDefault("codex")),
  },
  ({ name, repository, prompt, cron, tz, every, on, only, except, branch, action, key, agent }) =>
    Effect.gen(function* () {
      yield* checkName(name, "automation");
      const repo = yield* repoName(repository, "automation");
      if (Option.isSome(cron) !== Option.isSome(tz))
        return yield* usage("--cron needs --tz, an IANA zone such as Europe/London", "automation");
      const [when, ...more] = [
        ...(Option.isSome(cron) && Option.isSome(tz)
          ? [{ kind: "calendar", cron: cron.value, tz: tz.value }]
          : []),
        ...(Option.isSome(every) ? [{ kind: "interval", minutes: every.value }] : []),
        ...(Option.isSome(on) ? [{ kind: "event", connection: on.value }] : []),
      ];
      if (when === undefined || more.length > 0)
        return yield* usage("Give one of --cron (with --tz), --every or --on", "automation");
      const api = yield* withClient;
      yield* api("/api/automations", AutomationSwitched, {
        method: "POST",
        body: {
          name,
          when,
          repo,
          agent,
          action,
          prompt,
          ...(Option.isSome(branch) ? { branch: branch.value } : {}),
          ...(Option.isSome(key) ? { key: key.value } : {}),
          ...(Option.isSome(only) ? { only: parseFilter(only.value) } : {}),
          ...(Option.isSome(except) ? { except: parseFilter(except.value) } : {}),
        },
      });
      yield* output(
        { name, enabled: false },
        [
          `${green("✓")} Added ${bold(name)} ${dim("(off)")}`,
          dim(`  Turn it on: scotty automation enable ${name}`),
          dim(`  Try it now: scotty automation run ${name}`),
        ].join("\n"),
      );
    }),
);

const list = Command.make("ls", {}, () =>
  Effect.gen(function* () {
    const api = yield* withClient;
    const { automations: found } = yield* api("/api/automations", Automations);
    yield* output(
      { automations: found },
      found.length === 0
        ? `No automations yet. Add one: scotty automation add <name> owner/repo "What to do" --every 60`
        : found
            .map((automation) =>
              [
                `${bold(automation.name)} ${automation.enabled ? green("on") : dim("off")}  ${dim(lastRun(automation))}`,
                `  ${sentence(automation)}`,
              ].join("\n"),
            )
            .join("\n"),
    );
  }),
);

const enable = Command.make(
  "enable",
  { name: Argument.String("name"), off: Flag.Boolean("off").pipe(Flag.withDefault(false)) },
  ({ name, off }) =>
    Effect.gen(function* () {
      yield* checkName(name, "automation");
      const api = yield* withClient;
      const switched = yield* api(
        `/api/automations/${encodeURIComponent(name)}`,
        AutomationSwitched,
        { method: "PATCH", body: { enabled: !off } },
      );
      yield* output(switched, `${green("✓")} ${bold(name)} is ${switched.enabled ? "on" : "off"}`);
    }),
);

const run = Command.make("run", { name: Argument.String("name") }, ({ name }) =>
  Effect.gen(function* () {
    yield* checkName(name, "automation");
    const api = yield* withClient;
    const fired = yield* api(`/api/automations/${encodeURIComponent(name)}/run`, RunFired, {
      method: "POST",
    });
    yield* output(
      fired,
      [
        `${fired.status === "started" || fired.status === "steered" ? green("✓") : "•"} Run ${fired.id}: ${fired.status}${fired.reason === null ? "" : ` (${fired.reason})`}`,
        ...(fired.session === null
          ? []
          : [dim(`  Follow it: scotty read ${short(fired.session)}`)]),
      ].join("\n"),
    );
  }),
);

const remove = Command.make("rm", { name: Argument.String("name") }, ({ name }) =>
  Effect.gen(function* () {
    yield* checkName(name, "automation");
    const api = yield* withClient;
    const removed = yield* api(`/api/automations/${encodeURIComponent(name)}`, AutomationRemoved, {
      method: "DELETE",
    });
    yield* output(removed, `${green("✓")} Removed automation ${removed.name}`);
  }),
);

export const automation = Command.make("automation").pipe(
  Command.withSubcommands([add, list, enable, run, remove]),
);

export const runs = Command.make(
  "runs",
  { automation: Flag.String("automation").pipe(Flag.optional) },
  ({ automation: name }) =>
    Effect.gen(function* () {
      if (Option.isSome(name) && !automationName.test(name.value))
        return yield* usage("--automation is an automation name", "runs");
      const api = yield* withClient;
      const query = Option.isSome(name) ? `?automation=${encodeURIComponent(name.value)}` : "";
      const { runs: found } = yield* api(`/api/runs${query}`, Runs);
      yield* output(
        { runs: found },
        found.length === 0
          ? "No runs yet."
          : table([
              ["WHEN", "AUTOMATION", "TRIGGER", "RUN", "TURN", "SESSION", "ID"],
              ...found.map((item) => [
                ago(new Date(item.at).toISOString()),
                item.automation,
                item.trigger,
                item.reason === null ? item.status : `${item.status}: ${item.reason}`,
                item.outcome ?? "-",
                item.session === null ? "-" : short(item.session),
                item.id,
              ]),
            ]),
      );
    }),
);
