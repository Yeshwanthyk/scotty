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
} from "../../src/creds/connections.js";

// Pasted credentials arrive on stdin, never in argv or command output.
export const connect = Command.make(
  "connect",
  {
    kind: Argument.Literals("kind", ["webhook", "github", "token", "mcp"]),
    name: Argument.String("name"),
    host: Flag.String("host").pipe(Flag.optional),
    header: Flag.String("header").pipe(Flag.optional),
    endpoint: Flag.String("endpoint").pipe(Flag.optional),
  },
  ({ kind, name, host, header, endpoint }) =>
    Effect.gen(function* () {
      if (
        Option.isNone(
          Schema.decodeUnknownOption(
            kind === "webhook" || kind === "github" ? ConnectionName : InternalConnectionName,
          )(name),
        )
      )
        return yield* usage(
          "Use a non-reserved lowercase name of letters, digits and - (at most 40)",
          "connect",
        );
      if (
        ((kind === "webhook" || kind === "github") &&
          [host, header, endpoint].some(Option.isSome)) ||
        (kind === "token" &&
          (Option.isNone(host) || Option.isNone(header) || Option.isSome(endpoint))) ||
        (kind === "mcp" &&
          (Option.isNone(endpoint) || Option.isSome(host) || Option.isSome(header)))
      )
        return yield* usage(
          "Token needs --host and --header; MCP needs --endpoint; webhook and GitHub need only a name",
          "connect",
        );
      if ((kind === "token" || kind === "mcp") && process.stdin.isTTY)
        return yield* usage("Pipe the secret on stdin", "connect");
      const secret = kind === "webhook" || kind === "github" ? "" : (yield* readStdin).trim();
      const input = yield* Schema.decodeUnknownEffect(NewConnection)(
        kind === "webhook" || kind === "github"
          ? { kind, name }
          : kind === "token"
            ? {
                kind,
                name,
                host: Option.getOrUndefined(host),
                header: Option.getOrUndefined(header),
                secret,
              }
            : { kind, name, url: Option.getOrUndefined(endpoint), secret },
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
          `  URL     ${created.kind === "webhook" || created.kind === "github" ? created.url : created.internalUrl}`,
          ...(created.kind === "webhook" || created.kind === "github"
            ? [
                `  Secret  ${created.secret}`,
                dim(
                  created.kind === "github"
                    ? "  The secret is shown once. Paste it and the URL into GitHub webhook settings."
                    : "  The secret is shown once. Senders sign with it (Standard Webhooks).",
                ),
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
        ? "No connections yet. Add one: scotty connect webhook <name>"
        : table([
            ["NAME", "KIND", "URL"],
            ...found.map((connection) => [
              connection.name,
              connection.kind,
              connection.kind === "webhook" || connection.kind === "github"
                ? connection.url
                : connection.internalUrl,
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
