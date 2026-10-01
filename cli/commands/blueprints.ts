import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Automations, AutomationSwitched, ConnectionCreated, Connections } from "../client.js";
import { address, bold, dim, green, output, readStdin, usage, withClient } from "./common.js";
import { repoName } from "./sessions.js";
import { Blueprint, installation, taken } from "../../src/blueprints/blueprint.js";

const Secrets = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const readBlueprint = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path);
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.mapError(() => usage(`Could not read ${path}`, "blueprint")),
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(Blueprint))(text).pipe(
        Effect.catchTag("SchemaError", (error) =>
          usage(`${path} is not a blueprint: ${error.message}`, "blueprint"),
        ),
      ),
    ),
  );

// Pasted secrets arrive on stdin as one JSON object of connection name to secret, never in argv
// or output. Everything is created off; the owner pastes the hook URLs and secrets, then enables.
const install = Command.make(
  "install",
  {
    file: Argument.String("file"),
    repository: Flag.String("repo"),
    agent: Flag.Literals("agent", ["codex", "claude"]).pipe(Flag.withDefault("codex")),
  },
  ({ file, repository, agent }) =>
    Effect.gen(function* () {
      const blueprint = yield* readBlueprint(file);
      const repo = yield* repoName(repository, "blueprint");
      const piped = process.stdin.isTTY ? "" : (yield* readStdin).trim();
      const secrets =
        piped === ""
          ? {}
          : yield* Schema.decodeUnknownEffect(Secrets)(piped).pipe(
              Effect.catchTag("SchemaError", () =>
                usage(
                  'Pipe the secrets as one JSON object: {"<connection>": "<secret>"}',
                  "blueprint",
                ),
              ),
            );
      const plan = installation(blueprint, { repo, agent, secrets });
      if (!plan.ok) {
        const origin = new URL(yield* address).origin;
        return yield* usage(
          [
            plan.problem,
            ...blueprint.connections
              .filter((connection) => connection.kind === "inbound")
              .map(
                (connection) =>
                  `Hook URL for ${connection.name}: ${origin}/hooks/${connection.name}`,
              ),
          ].join("\n"),
          "blueprint",
        );
      }
      const api = yield* withClient;
      const [{ connections: existing }, { automations }] = yield* Effect.all([
        api("/api/connections", Connections),
        api("/api/automations", Automations),
      ]);
      const clash = taken(blueprint, {
        connections: existing.map((connection) => connection.name),
        automations: automations.map((automation) => automation.name),
      });
      if (clash.length > 0) return yield* usage(`Already exists: ${clash.join(", ")}`, "blueprint");
      const made: string[] = [];
      const created = yield* Effect.gen(function* () {
        const connections = yield* Effect.forEach(plan.installation.connections, (body) =>
          api("/api/connections", ConnectionCreated, { method: "POST", body }).pipe(
            Effect.tap(() => Effect.sync(() => made.push(`connection ${body.name}`))),
          ),
        );
        yield* Effect.forEach(plan.installation.automations, (body) =>
          api("/api/automations", AutomationSwitched, { method: "POST", body }).pipe(
            Effect.tap(() => Effect.sync(() => made.push(`automation ${body.name}`))),
          ),
        );
        return connections;
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (made.length > 0) console.error(`Created before the failure: ${made.join(", ")}`);
          }),
        ),
      );
      const setup = (name: string) => {
        const text = blueprint.connections.find((connection) => connection.name === name)?.setup;
        return text === undefined ? [] : [dim(`    ${text}`)];
      };
      const names = plan.installation.automations.map((automation) => automation.name);
      yield* output(
        { blueprint: blueprint.name, connections: created, automations: names },
        [
          `${green("✓")} Installed ${bold(blueprint.title)} for ${repo}, off`,
          ...created.flatMap((connection) => [
            `  ${bold(connection.name)}  ${connection.kind === "inbound" ? connection.url : connection.internalUrl}`,
            ...(connection.kind === "inbound" && connection.secret !== null
              ? [`    Secret  ${connection.secret}`, dim("    The secret is shown once.")]
              : []),
            ...(connection.kind === "mcp" && connection.signIn !== "signed-in"
              ? [`    Sign in: scotty mcp signin ${connection.name}`]
              : []),
            ...setup(connection.name),
          ]),
          `  Automations: ${names.join(", ")}`,
          dim(
            `  Turn them on: ${names.map((name) => `scotty automation enable ${name}`).join("; ")}`,
          ),
        ].join("\n"),
      );
    }),
);

export const blueprint = Command.make("blueprint").pipe(Command.withSubcommands([install]));
