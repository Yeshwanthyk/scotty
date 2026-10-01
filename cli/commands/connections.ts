import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ConnectionCreated, ConnectionRemoved, Connections, Deliveries } from "../client.js";
import {
  type Api,
  ago,
  bold,
  dim,
  green,
  output,
  readStdin,
  short,
  table,
  usage,
  withClient,
} from "./common.js";
import {
  NewConnection,
  ConnectionName,
  InternalConnectionName,
  connectionName,
  ConnectionAuthorization,
  ToolPolicy,
} from "../../src/creds/connections.js";
import { SignaturePreset } from "../../src/hooks/config.js";

// Pasted credentials arrive on stdin, never in argv or command output.
export const connect = Command.make(
  "connect",
  {
    kind: Argument.Literals("kind", [...SignaturePreset.literals, "token", "mcp"]),
    name: Argument.String("name"),
    host: Flag.String("host").pipe(Flag.optional),
    header: Flag.String("header").pipe(Flag.optional),
    oauth: Flag.Boolean("oauth"),
    endpoint: Flag.String("endpoint").pipe(Flag.optional),
  },
  ({ kind, name, host, header, endpoint, oauth }) =>
    Effect.gen(function* () {
      if (
        Option.isNone(
          Schema.decodeUnknownOption(
            kind !== "token" && kind !== "mcp" ? ConnectionName : InternalConnectionName,
          )(name),
        )
      )
        return yield* usage(
          "Use a non-reserved lowercase name of letters, digits and - (at most 40)",
          "connect",
        );
      if (
        (kind !== "token" && kind !== "mcp" && [host, header, endpoint].some(Option.isSome)) ||
        (kind === "token" &&
          (Option.isNone(host) || Option.isNone(header) || Option.isSome(endpoint))) ||
        (kind === "mcp" &&
          (Option.isNone(endpoint) || Option.isSome(host) || Option.isSome(header)))
      )
        return yield* usage(
          "Token needs --host and --header; MCP needs --endpoint; inbound presets need only a name",
          "connect",
        );
      if (oauth && kind !== "mcp") return yield* usage("--oauth is for MCP servers", "connect");
      if ((kind === "token" || (kind === "mcp" && !oauth)) && process.stdin.isTTY)
        return yield* usage("Pipe the secret on stdin", "connect");
      const secret = oauth || process.stdin.isTTY ? "" : (yield* readStdin).trim();
      const input = yield* Schema.decodeUnknownEffect(NewConnection)(
        kind !== "token" && kind !== "mcp"
          ? {
              kind: "inbound",
              name,
              signing: { kind: "preset", preset: kind },
              ...(secret === "" ? {} : { secret }),
            }
          : kind === "token"
            ? {
                kind,
                name,
                host: Option.getOrUndefined(host),
                header: Option.getOrUndefined(header),
                secret,
              }
            : { kind, name, url: Option.getOrUndefined(endpoint), ...(oauth ? {} : { secret }) },
      ).pipe(
        Effect.catchTag("SchemaError", () =>
          usage(
            "Use an HTTPS target, a header like Authorization: Bearer or X-Api-Key, and a non-blank secret",
            "connect",
          ),
        ),
      );
      const api = yield* withClient;
      const created = yield* api("/api/connections", ConnectionCreated, {
        method: "POST",
        body: input,
      });
      yield* output(
        created,
        [
          `${green("✓")} Connected ${bold(created.name)}`,
          `  URL     ${created.kind === "inbound" ? created.url : created.internalUrl}`,
          ...(created.kind === "inbound"
            ? [
                ...(created.secret === null
                  ? []
                  : [
                      `  Secret  ${created.secret}`,
                      dim(
                        "  The secret is shown once. Paste it and the URL into the sender's webhook settings.",
                      ),
                    ]),
                dim(`  See deliveries: scotty deliveries --connection ${created.name}`),
              ]
            : [
                dim(
                  "  The credential stays in Scotty. Stop and resume a session to pick up new connections.",
                ),
              ]),
        ].join("\n"),
      );
    }),
);

export const connections = Command.make("connections", {}, () =>
  Effect.gen(function* () {
    const api = yield* withClient;
    const { connections: found } = yield* api("/api/connections", Connections);
    yield* output(
      { connections: found },
      found.length === 0
        ? "No connections yet. Add one: scotty connect standard-webhooks <name>"
        : table([
            ["NAME", "KIND", "URL", "SIGN-IN", "TOOLS"],
            ...found.map((connection) => [
              connection.name,
              connection.kind,
              connection.kind === "inbound" ? connection.url : connection.internalUrl,
              connection.kind === "mcp" ? connection.signIn : "-",
              connection.kind === "mcp"
                ? connection.policy.kind === "named"
                  ? connection.policy.tools.join(", ")
                  : connection.policy.kind
                : "-",
            ]),
          ]),
    );
  }),
);

export const deliveries = Command.make(
  "deliveries",
  { connection: Flag.String("connection").pipe(Flag.optional) },
  ({ connection }) =>
    Effect.gen(function* () {
      if (Option.isSome(connection) && !connectionName.test(connection.value))
        return yield* usage("--connection is a connection name", "deliveries");
      const api = yield* withClient;
      const query = Option.isSome(connection)
        ? `?connection=${encodeURIComponent(connection.value)}`
        : "";
      const { deliveries: found } = yield* api(`/api/deliveries${query}`, Deliveries);
      yield* output(
        { deliveries: found },
        found.length === 0
          ? "No deliveries yet."
          : table([
              ["WHEN", "CONNECTION", "OUTCOME", "SESSION", "ID"],
              ...found.map((delivery) => [
                ago(new Date(delivery.at).toISOString()),
                delivery.connection,
                delivery.reason === null
                  ? delivery.outcome
                  : `${delivery.outcome}: ${delivery.reason}`,
                delivery.session === null ? "-" : short(delivery.session),
                delivery.id,
              ]),
            ]),
      );
    }),
);

export const removeConnection = (api: Api, name: string) =>
  Effect.gen(function* () {
    const removed = yield* api(`/api/connections/${encodeURIComponent(name)}`, ConnectionRemoved, {
      method: "DELETE",
    });
    yield* output(removed, `${green("✓")} Removed connection ${removed.name}`);
  });

const signin = Command.make("signin", { name: Argument.String("name") }, ({ name }) =>
  Effect.gen(function* () {
    if (Option.isNone(Schema.decodeUnknownOption(ConnectionName)(name)))
      return yield* usage("Use a connection name", "mcp");
    const api = yield* withClient;
    const result = yield* api(`/api/connections/${name}/connect`, ConnectionAuthorization, {
      method: "POST",
    });
    yield* output(result, `Open in your Access-signed-in browser:\n${result.authorizationUrl}`);
  }),
);
const policy = Command.make(
  "policy",
  {
    name: Argument.String("name"),
    mode: Argument.Literals("mode", ["all", "read-only", "named"]),
    tools: Flag.String("tools").pipe(Flag.optional),
  },
  ({ name, mode, tools }) =>
    Effect.gen(function* () {
      if (Option.isNone(Schema.decodeUnknownOption(ConnectionName)(name)))
        return yield* usage("Use a connection name", "mcp");
      if ((mode === "named") !== Option.isSome(tools))
        return yield* usage(
          "Named policy needs --tools name,other; other policies take no --tools",
          "mcp",
        );
      const value = yield* Schema.decodeUnknownEffect(ToolPolicy)(
        mode === "named"
          ? {
              kind: mode,
              tools: Option.getOrElse(tools, () => "")
                .split(",")
                .map((tool) => tool.trim()),
            }
          : { kind: mode },
      ).pipe(Effect.catchTag("SchemaError", () => usage("Use non-blank tool names", "mcp")));
      const api = yield* withClient;
      const result = yield* api(
        `/api/connections/${name}/policy`,
        Schema.Struct({ name: Schema.String, policy: ToolPolicy }),
        { method: "PUT", body: value },
      );
      yield* output(
        result,
        `Tools for ${name}: ${mode === "named" ? Option.getOrElse(tools, () => "") : mode}`,
      );
    }),
);
export const mcp = Command.make("mcp").pipe(Command.withSubcommands([signin, policy]));
