import { Option, Schema } from "effect";
import { request } from "./core";
import {
  Definition as DefinitionSchema,
  RunStatus,
  describeFilter,
} from "../../../src/automations/automation";

const Run = Schema.Struct({
  id: Schema.String,
  automation: Schema.String,
  trigger: Schema.Literals(["schedule", "event", "manual"]),
  at: Schema.Number,
  status: RunStatus,
  reason: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
  delivery: Schema.NullOr(Schema.String),
  key: Schema.NullOr(Schema.String),
});
const Automation = Schema.Struct({
  name: Schema.String,
  ...DefinitionSchema.fields,
  enabled: Schema.Boolean,
  nextDue: Schema.NullOr(Schema.Number),
  lastRun: Schema.NullOr(Run),
});
const Automations = Schema.Struct({ automations: Schema.Array(Automation) });
// How the turn a run sent went, read from its session; null when it reached none.
const Runs = Schema.Struct({
  runs: Schema.Array(
    Schema.Struct({
      ...Run.fields,
      outcome: Schema.NullOr(
        Schema.Literals(["working", "completed", "aborted", "failed", "stopped"]),
      ),
    }),
  ),
});
const Fired = Schema.Struct({
  id: Schema.String,
  status: Run.fields.status,
  reason: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
});

export type When = Definition["when"];
export type Definition = typeof DefinitionSchema.Type;
export type Automation = typeof Automation.Type;
export type Run = (typeof Runs.Type)["runs"][number];

function decode<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
  what: string,
): S["Type"] {
  const result = Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));
  if (result === undefined) throw new Error(`Unreadable ${what}`);
  return result;
}

const path = (name: string) => `/api/automations/${encodeURIComponent(name)}`;

// One line a person reads: when it fires, what must match, and what it starts.
export function sentence(automation: Automation): string {
  const { when } = automation;
  const start =
    when.kind === "calendar"
      ? `At cron ${when.cron} (${when.tz})`
      : when.kind === "interval"
        ? `Every ${when.minutes} minute${when.minutes === 1 ? "" : "s"}`
        : `On each delivery to ${when.connection}`;
  const only = describeFilter(automation.only ?? {});
  const except = describeFilter(automation.except ?? {});
  const agent = automation.agent === "claude" ? "Claude" : "Codex";
  const action = automation.action ?? "start";
  const verb =
    action === "start"
      ? `start or wake a ${agent} session`
      : action === "wake"
        ? `wake the ${agent} session`
        : "end the session and release its key";
  return `${start}${only.length === 0 ? "" : `, when ${only.join(" and ")}`}${except.length === 0 ? "" : `, except when ${except.join(" and ")}`}, ${verb} on ${automation.repo}${automation.branch === undefined ? "" : ` from ${automation.branch}`}${automation.key === undefined ? "" : `, key ${automation.key}`}.`;
}

export async function automations(signal?: AbortSignal): Promise<Automation[]> {
  const value = await request("/api/automations", undefined, signal);
  return [...decode(Automations, value, "automations").automations];
}

export async function runs(automation?: string, signal?: AbortSignal): Promise<Run[]> {
  const query = automation === undefined ? "" : `?automation=${encodeURIComponent(automation)}`;
  return [...decode(Runs, await request(`/api/runs${query}`, undefined, signal), "runs").runs];
}

// A new or changed automation is off until it is switched on.
export async function saveAutomation(
  name: string,
  definition: Definition,
  existing: boolean,
): Promise<void> {
  if (existing) await request(path(name), definition, undefined, undefined, "PUT");
  else await request("/api/automations", { name, ...definition });
}

export async function switchAutomation(name: string, enabled: boolean): Promise<void> {
  await request(path(name), { enabled }, undefined, undefined, "PATCH");
}

export async function runAutomation(name: string): Promise<typeof Fired.Type> {
  return decode(Fired, await request(`${path(name)}/run`, {}), "run");
}

export async function removeAutomation(name: string): Promise<void> {
  await request(path(name), undefined, undefined, undefined, "DELETE");
}
