import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ConnectionCreated, ConnectionRemoved, Connections, Deliveries } from "../client.js";
import {
  type Api,
  ago,
  bold,
  dim,
  green,
  output,
  short,
  table,
  usage,
  withClient,
} from "./common.js";
import { connectionName } from "../../src/creds/connections.js";

// `scotty connect webhook <name>` makes the URL and the secret a sender signs with.
export const connect = Command.make(
  "connect",
  {
    kind: Argument.Literals("kind", ["webhook"]),
    name: Argument.String("name"),
  },
  ({ name }) =>
    Effect.gen(function* () {
      if (!connectionName.test(name))
        return yield* usage(
          "A name is lowercase letters, digits and - (at most 40), starting with a letter or digit",
          "connect",
        );
      const api = yield* withClient;
      const created = yield* api("/api/connections", ConnectionCreated, {
        method: "POST",
        body: { kind: "webhook", name },
      });
      yield* output(
        created,
        [
          `${green("✓")} Connected ${bold(created.name)}`,
          `  URL     ${created.url}`,
          `  Secret  ${created.secret}`,
          dim("  The secret is shown once. Senders sign with it (Standard Webhooks)."),
          dim(`  Body: {"repo": "owner/repo", "prompt": "…", "key": "optional"}`),
          dim(`  See deliveries: scotty deliveries --connection ${created.name}`),
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
            ...found.map((connection) => [connection.name, connection.kind, connection.url]),
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
