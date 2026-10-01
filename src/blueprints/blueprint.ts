import { Option, Result, Schema, Struct } from "effect";
import { NewAutomation } from "../automations/automation.js";
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

// An automation as the API takes it; the installer chooses its repo and agent.
export const BlueprintAutomation = NewAutomation.mapFields(
  Struct.omit(["repo", "agent", "scripted"]),
);

// Only data: everything a blueprint makes can be made by hand through the same API.
export const Blueprint = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/)),
  title: Text(100),
  description: Text(2000),
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
);
export type Blueprint = typeof Blueprint.Type;

export type Installation = {
  readonly connections: ReadonlyArray<typeof NewConnection.Type>;
  readonly automations: ReadonlyArray<typeof NewAutomation.Type>;
};

export type Choices = {
  readonly repo: typeof Repo.Type;
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
  const automations: Array<typeof NewAutomation.Type> = [];
  for (const automation of blueprint.automations) {
    const decoded = Schema.decodeUnknownResult(NewAutomation)({
      ...automation,
      repo: choices.repo,
      agent: choices.agent,
      ...(choices.scripted === undefined ? {} : { scripted: choices.scripted }),
    });
    if (Result.isFailure(decoded))
      return { ok: false, problem: `${automation.name}: ${decoded.failure.message}` };
    automations.push(decoded.success);
  }
  return { ok: true, installation: { connections, automations } };
}
// Which names a blueprint would make that already exist.
export const taken = (
  blueprint: Blueprint,
  existing: { readonly connections: readonly string[]; readonly automations: readonly string[] },
) => [
  ...blueprint.connections
    .filter((connection) => existing.connections.includes(connection.name))
    .map((connection) => `connection ${connection.name}`),
  ...blueprint.automations
    .filter((automation) => existing.automations.includes(automation.name))
    .map((automation) => `automation ${automation.name}`),
];
