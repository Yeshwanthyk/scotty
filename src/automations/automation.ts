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

// Each field (a dotted path into the payload) must equal the value, or one of the values.
export const Only = Schema.Record(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  Schema.Union([Schema.String, Schema.Array(Schema.String).check(Schema.isMinLength(1))]),
).check(Schema.isMaxProperties(20));
export type Only = typeof Only.Type;

const Template = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64 * 1024));

// What the owner (or an agent) writes. `key` and `prompt` are templates over the payload.
export const Definition = Schema.Struct({
  when: When,
  only: Schema.optionalKey(Only),
  key: Schema.optionalKey(Template.check(Schema.isMaxLength(200))),
  repo: Repo,
  agent: AgentKind,
  prompt: Template,
  // Runs the agent's scripted stand-in instead of the agent; only e2e asks for it.
  scripted: Schema.optionalKey(Schema.Literal(true)),
});
export type Definition = typeof Definition.Type;

export const RunTrigger = Schema.Literals(["schedule", "event", "manual"]);
// A run is received until a session takes its prompt (started or steered) or it fails; a run
// that never fires is skipped, with the reason.
export const RunStatus = Schema.Literals(["received", "skipped", "failed", "started", "steered"]);

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
const field = (payload: unknown, path: string): unknown =>
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

// Why a payload does not match, or undefined when it does.
export function mismatch(only: Only, payload: unknown): string | undefined {
  for (const [path, wanted] of Object.entries(only)) {
    const value = scalar(field(payload, path));
    const allowed = typeof wanted === "string" ? [wanted] : wanted;
    if (value === undefined || !allowed.includes(value))
      return `${path} is ${value === undefined ? "missing" : JSON.stringify(value)}`;
  }
  return undefined;
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
  const prompt = render(definition.prompt, payload);
  if (!prompt.ok) return { status: "skipped" as const, reason: `no ${prompt.missing} for prompt` };
  if (prompt.text.trim() === "") return { status: "skipped" as const, reason: "empty prompt" };
  if (definition.key === undefined)
    return { status: "received" as const, prompt: prompt.text, key: null };
  const key = render(definition.key, payload);
  if (!key.ok) return { status: "skipped" as const, reason: `no ${key.missing} for key` };
  if (key.text === "" || key.text.length > 200)
    return { status: "skipped" as const, reason: "key is empty or too long" };
  return { status: "received" as const, prompt: prompt.text, key: key.text };
}
