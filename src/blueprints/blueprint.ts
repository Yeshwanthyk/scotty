import { Option, Result, Schema, Struct } from "effect";
import { automationName, NewAutomation } from "../automations/automation.js";
import { NewConnection } from "../creds/connections.js";
import { Repo } from "../http/start.js";
import { AgentKind } from "../session/events.js";

const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

// What the installer shows next to a connection: the question for its secret (a blank answer
// is refused unless it is optional), and what to paste where once it exists.
const guide = {
  ask: Schema.optionalKey(
    Schema.Struct({ prompt: Text(500), optional: Schema.optionalKey(Schema.Literal(true)) }),
  ),
  setup: Schema.optionalKey(Text(2000)),
};
const [inbound, token, mcp] = NewConnection.members;

// A connection as the API takes it, without its secret: the installer asks for that.
export const BlueprintConnection = Schema.Union([
  inbound.mapFields((fields) => ({ ...Struct.omit(fields, ["secret"]), ...guide })),
  token.mapFields((fields) => ({ ...Struct.omit(fields, ["secret"]), ...guide })),
  mcp.mapFields((fields) => ({ ...Struct.omit(fields, ["secret"]), ...guide })),
]);
export type BlueprintConnection = typeof BlueprintConnection.Type;

// Replaced at install time by each target's name, unlike the payload's {{…}} templates.
const placeholder = "${target}";

// An automation as the API takes it; the installer chooses its repo and agent. A per-target one
// is copied once per target, with ${target} in its text and name standing for that target.
export const BlueprintAutomation = NewAutomation.mapFields((fields) => ({
  ...Struct.omit(fields, ["repo", "agent", "scripted"]),
  name: Schema.String.check(
    Schema.makeFilter((name) => automationName.test(name.replaceAll(placeholder, "x")), {
      expected: "an automation name, where ${target} may stand for a target's name",
    }),
  ),
  perTarget: Schema.optionalKey(Schema.Literal(true)),
}));

// Only data: everything a blueprint makes can be made by hand through the same API.
export const Blueprint = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/)),
  title: Text(100),
  description: Text(2000),
  // The question the installer asks for the targets, each a name and the repo it works in.
  targets: Schema.optionalKey(Schema.Struct({ ask: Text(500) })),
  connections: Schema.Array(BlueprintConnection),
  automations: Schema.Array(BlueprintAutomation),
}).check(
  Schema.makeFilter(
    (blueprint) =>
      blueprint.connections.every(
        (connection) =>
          connection.kind !== "token" ||
          (connection.ask !== undefined && connection.ask.optional === undefined),
      ),
    { expected: "a required question for every token connection's secret" },
  ),
  Schema.makeFilter(
    (blueprint) =>
      blueprint.automations.every(
        ({ when }) =>
          when.kind !== "event" ||
          blueprint.connections.some((connection) => connection.name === when.connection),
      ),
    { expected: "event automations that listen on the blueprint's own connections" },
  ),
  Schema.makeFilter(
    (blueprint) =>
      (blueprint.targets !== undefined) ===
      blueprint.automations.some((automation) => automation.perTarget === true),
    { expected: "targets declared exactly when an automation is per target" },
  ),
  Schema.makeFilter(
    (blueprint) =>
      blueprint.automations.every((automation) =>
        automation.perTarget === true
          ? automation.name.includes(placeholder)
          : !JSON.stringify(automation).includes(placeholder),
      ),
    { expected: "${target} in every per-target automation's name and in no other automation" },
  ),
);
export type Blueprint = typeof Blueprint.Type;

export type Installation = {
  readonly connections: ReadonlyArray<typeof NewConnection.Type>;
  readonly automations: ReadonlyArray<typeof NewAutomation.Type>;
};

// A target's name may become filter values and prompt text, so it may not add a {{…}} template.
export const Target = Schema.Struct({
  name: Text(100).check(
    Schema.makeFilter((name) => !name.includes("{{") && !name.includes("}}"), {
      expected: "a name without {{ or }}",
    }),
  ),
  repo: Repo,
});
export const Targets = Schema.Array(Target).check(
  Schema.makeFilter((targets) => new Set(targets.map(({ name }) => name)).size === targets.length, {
    expected: "targets with distinct names",
  }),
);

export type Choices = {
  // The repo for automations that are not per target, and the targets for those that are; each
  // is given exactly when the blueprint has such automations.
  readonly repo?: typeof Repo.Type;
  readonly targets?: ReadonlyArray<typeof Target.Type>;
  readonly agent: typeof AgentKind.Type;
  // Pasted secrets by connection name; a blank one counts as not given.
  readonly secrets: Readonly<Record<string, string>>;
  readonly scripted?: true;
};

// The API requests a blueprint makes with the installer's choices, all checked before any is
// sent. A problem names the connection or automation, never a secret.
export function installation(
  blueprint: Blueprint,
  choices: Choices,
): { ok: true; installation: Installation } | { ok: false; problem: string } {
  const connections: Array<typeof NewConnection.Type> = [];
  for (const connection of blueprint.connections) {
    const secret = choices.secrets[connection.name]?.trim() ?? "";
    if (secret === "" && connection.ask !== undefined && connection.ask.optional === undefined)
      return { ok: false, problem: `${connection.name} needs ${connection.ask.prompt}` };
    const input = Struct.omit(connection, ["ask", "setup"]);
    const decoded = Schema.decodeUnknownOption(NewConnection)(
      secret === "" ? input : { ...input, secret },
    );
    if (Option.isNone(decoded))
      return { ok: false, problem: `The secret for ${connection.name} is not valid` };
    connections.push(decoded.value);
  }
  const shared = blueprint.automations.some((automation) => automation.perTarget === undefined);
  const repo = choices.repo?.trim() ?? "";
  if (shared === (repo === ""))
    return {
      ok: false,
      problem: shared
        ? `${blueprint.title} needs a repo`
        : `${blueprint.title} takes targets, not one repo`,
    };
  const given = choices.targets ?? [];
  if (blueprint.targets === undefined && given.length > 0)
    return { ok: false, problem: `${blueprint.title} takes no targets` };
  if (blueprint.targets !== undefined && given.length === 0)
    return { ok: false, problem: `${blueprint.title} needs ${blueprint.targets.ask}` };
  const targets = Schema.decodeUnknownResult(Targets)(given);
  if (Result.isFailure(targets))
    return { ok: false, problem: `Targets: ${targets.failure.message}` };
  const slugs = new Map<string, string>();
  for (const target of targets.success) {
    const name = slug(target.name);
    if (name === "")
      return {
        ok: false,
        problem: `Target ${target.name} has no letter or digit to name its automations`,
      };
    const other = slugs.get(name);
    if (other !== undefined)
      return { ok: false, problem: `Targets ${other} and ${target.name} both name as ${name}` };
    slugs.set(name, target.name);
  }
  const copies = blueprint.automations.flatMap<{
    automation: Readonly<Record<string, unknown>> & { readonly name: string };
    repo: string;
    target?: string;
  }>(({ perTarget, ...automation }) =>
    perTarget === undefined
      ? [{ automation, repo }]
      : targets.success.map((target) => ({
          automation: {
            ...Object.fromEntries(
              Object.entries(automation).map(([key, value]) => [key, fill(value, target.name)]),
            ),
            name: automation.name.replaceAll(placeholder, slug(target.name)),
          },
          repo: target.repo,
          target: target.name,
        })),
  );
  const automations: Array<typeof NewAutomation.Type> = [];
  for (const { automation, repo: home, target } of copies) {
    const name = automation.name;
    if (target !== undefined && !automationName.test(name))
      return {
        ok: false,
        problem: `Target ${target}: ${name} is not an automation name (at most 40 lowercase letters, digits and dashes)`,
      };
    if (automations.some((made) => made.name === name))
      return { ok: false, problem: `Two automations would be named ${name}` };
    const decoded = Schema.decodeUnknownResult(NewAutomation)({
      ...automation,
      repo: home,
      agent: choices.agent,
      ...(choices.scripted === undefined ? {} : { scripted: choices.scripted }),
    });
    if (Result.isFailure(decoded))
      return { ok: false, problem: `${name}: ${decoded.failure.message}` };
    automations.push(decoded.success);
  }
  return { ok: true, installation: { connections, automations } };
}

// A target's name as automation names can carry it: lowercase, other characters as dashes.
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Every string in a decoded value with ${target} replaced, so no escaping is touched.
const fill = (value: unknown, target: string): unknown =>
  typeof value === "string"
    ? value.replaceAll(placeholder, target)
    : Array.isArray(value)
      ? value.map((item) => fill(item, target))
      : typeof value === "object" && value !== null
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, target)]))
        : value;

// Which names an installation would make that already exist.
export const taken = (
  installation: Installation,
  existing: { readonly connections: readonly string[]; readonly automations: readonly string[] },
) => [
  ...installation.connections
    .filter((connection) => existing.connections.includes(connection.name))
    .map((connection) => `connection ${connection.name}`),
  ...installation.automations
    .filter((automation) => existing.automations.includes(automation.name))
    .map((automation) => `automation ${automation.name}`),
];
