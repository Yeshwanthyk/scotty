import { Cron, Result, Schema } from "effect";
import { ConnectionName } from "../creds/connections.js";
import { Repo } from "../http/start.js";
import { AgentKind } from "../session/events.js";

// Lowercase and explicit, like a connection's: the name is in every run and session it starts.
export const automationName = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const AutomationName = Schema.String.check(Schema.isPattern(automationName));

// A calendar schedule is five cron fields read in an IANA zone; an interval counts from when
// the automation was enabled; an event is a delivery to a connection.
export const When = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("calendar"),
    cron: Schema.String,
    tz: Schema.String,
  }).check(
    Schema.makeFilter(
      (when) =>
        when.cron.trim().split(/\s+/).length === 5 &&
        Result.isSuccess(Cron.parse(when.cron, when.tz)),
      { expected: "five cron fields and an IANA time zone" },
    ),
  ),
  Schema.Struct({
    kind: Schema.Literal("interval"),
    minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 * 24 * 60 })),
  }),
  Schema.Struct({ kind: Schema.Literal("event"), connection: ConnectionName }),
]);
export type When = typeof When.Type;

const Match = Schema.Union([
  Schema.String,
  Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  Schema.Struct({ kind: Schema.Literal("contains"), value: Schema.String }),
]);
const Filter = Schema.Record(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  Match,
).check(Schema.isMaxProperties(20));
export type Filter = typeof Filter.Type;
export const Action = Schema.Literals(["start", "wake", "end"]);

const Template = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64 * 1024));

// What the owner (or an agent) writes. The prompt, key and branch are payload templates.
export const Definition = Schema.Struct({
  when: When,
  only: Schema.optionalKey(Filter),
  except: Schema.optionalKey(Filter),
  action: Schema.optionalKey(Action),
  key: Schema.optionalKey(Template.check(Schema.isMaxLength(200))),
  branch: Schema.optionalKey(Template.check(Schema.isMaxLength(200))),
  repo: Repo,
  agent: AgentKind,
  prompt: Template,
  // Runs the agent's scripted stand-in instead of the agent; only e2e asks for it.
  scripted: Schema.optionalKey(Schema.Literal(true)),
});
export type Definition = typeof Definition.Type;
export const NewAutomation = Schema.Struct({ name: AutomationName, ...Definition.fields });

export const RunTrigger = Schema.Literals(["schedule", "event", "manual"]);
// A run stays received until its session answers the action; a skipped run names its reason.
export const RunStatus = Schema.Literals([
  "received",
  "skipped",
  "failed",
  "started",
  "steered",
  "ended",
]);

// A schedule that wakes this long after its time is past: that run is skipped, not late.
export const missedAfterMs = 10 * 60_000;
// A received run is fired again after this long without an answer, for up to an hour.
export const refireAfterMs = 60_000;
export const giveUpAfterMs = 60 * 60_000;

// The next time a schedule is due strictly after `after`; events have none.
export function nextDue(when: When, after: number): number | null {
  if (when.kind === "event") return null;
  if (when.kind === "interval") return after + when.minutes * 60_000;
  const cron = Cron.parse(when.cron, when.tz);
  return Result.isSuccess(cron) ? Cron.next(cron.success, after).getTime() : null;
}

// The value at a dotted path, or undefined when any step is missing.
export const field = (payload: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (value, step) =>
        typeof value === "object" && value !== null && Object.hasOwn(value, step)
          ? Reflect.get(value, step)
          : undefined,
      payload,
    );

const scalar = (value: unknown) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : undefined;

// A field's text as a template renders it: text as it is, anything else as JSON.
const asText = (value: unknown) =>
  value === undefined ? undefined : typeof value === "string" ? value : JSON.stringify(value);

// Why a payload does not match, or undefined when it does.
function mismatch(filter: Filter, payload: unknown): string | undefined {
  for (const [path, wanted] of Object.entries(filter)) {
    const raw = field(payload, path);
    const value = scalar(raw);
    const matched =
      typeof wanted === "string"
        ? value === wanted
        : "kind" in wanted
          ? asText(raw)?.includes(wanted.value) === true
          : value !== undefined && wanted.includes(value);
    if (!matched)
      return raw === undefined
        ? `${path} is missing`
        : typeof wanted !== "string" && "kind" in wanted
          ? `${path} does not contain ${JSON.stringify(wanted.value)}`
          : `${path} is ${value === undefined ? "a list or object" : JSON.stringify(value)}`;
  }
  return undefined;
}

export function parseFilter(fields: Readonly<Record<string, string>>): Filter {
  return Object.fromEntries<Filter[string]>(
    Object.entries(fields).map(([path, text]): [string, Filter[string]] => {
      if (text.startsWith("~")) {
        const value = text.slice(1);
        const literal = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.String))(value);
        return [
          path,
          { kind: "contains", value: Result.isSuccess(literal) ? literal.success : value },
        ];
      }
      const literal = Schema.decodeUnknownResult(Schema.fromJsonString(Match))(text);
      if (Result.isSuccess(literal)) return [path, literal.success];
      const values = text.split(",");
      return [path, values.length === 1 ? text : values];
    }),
  );
}

export function describeFilter(filter: Filter): string[] {
  return Object.entries(filter).map(([path, wanted]) =>
    typeof wanted === "string"
      ? `${path} is ${wanted}`
      : "kind" in wanted
        ? `${path} contains ${JSON.stringify(wanted.value)}`
        : `${path} is ${wanted.join(" or ")}`,
  );
}

// `{{a.b}}` becomes that payload field: text as it is, anything else as JSON.
export function render(
  template: string,
  payload: unknown,
): { ok: true; text: string } | { ok: false; missing: string } {
  let missing: string | undefined;
  const text = template.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_, path: string) => {
    const value = field(payload, path);
    if (value === undefined) {
      missing ??= path;
      return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  });
  return missing === undefined ? { ok: true, text } : { ok: false, missing };
}

// What a firing does with its payload: the rendered prompt and key, or why it is skipped.
export function prepare(definition: Definition, payload: unknown) {
  const reason = definition.only === undefined ? undefined : mismatch(definition.only, payload);
  if (reason !== undefined) return { status: "skipped" as const, reason: `not matched: ${reason}` };
  if (
    definition.except !== undefined &&
    Object.keys(definition.except).length > 0 &&
    mismatch(definition.except, payload) === undefined
  )
    return {
      status: "skipped" as const,
      reason: `except matched: ${describeFilter(definition.except).join(" and ")}`,
    };
  const prompt = render(definition.prompt, payload);
  if (!prompt.ok) return { status: "skipped" as const, reason: `no ${prompt.missing} for prompt` };
  if (prompt.text.trim() === "") return { status: "skipped" as const, reason: "empty prompt" };
  const branch =
    definition.branch === undefined
      ? { ok: true as const, text: null }
      : render(definition.branch, payload);
  if (!branch.ok) return { status: "skipped" as const, reason: `no ${branch.missing} for branch` };
  if (branch.text !== null && (branch.text.trim() === "" || branch.text.length > 200))
    return { status: "skipped" as const, reason: "branch is empty or too long" };
  const key =
    definition.key === undefined
      ? { ok: true as const, text: null }
      : render(definition.key, payload);
  if (!key.ok) return { status: "skipped" as const, reason: `no ${key.missing} for key` };
  if (key.text !== null && (key.text === "" || key.text.length > 200))
    return { status: "skipped" as const, reason: "key is empty or too long" };
  return { status: "received" as const, prompt: prompt.text, key: key.text, branch: branch.text };
}
