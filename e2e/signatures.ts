import { Effect, Schema } from "effect";
import {
  access,
  CliFailure,
  client,
  ConnectionCreated,
  ConnectionRemoved,
  Connections,
  Deliveries,
  failure,
  target,
} from "../cli/client.js";

const check = (ok: boolean, message: string) =>
  ok ? Effect.void : Effect.fail(failure("signatures", message, "scotty deliveries"));
const Skipped = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Literal("skipped"),
    reason: Schema.Literal("no_automation"),
  }),
);
const Rejected = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({ code: Schema.Literals(["bad_signature", "stale_timestamp"]) }),
  }),
);

// Independent provider-shaped senders: do not use the production signature configuration.
const deliver = (
  url: string,
  secret: string,
  preset: "linear" | "slack",
  options: { tamper?: boolean; stale?: boolean } = {},
) =>
  Effect.promise(async () => {
    const id = crypto.randomUUID();
    const at = Date.now() - (options.stale ? (preset === "linear" ? 90_000 : 360_000) : 0);
    const timestamp = String(Math.floor(at / 1000));
    const body = JSON.stringify(
      preset === "linear"
        ? { action: "update", type: "Issue", webhookTimestamp: at, data: { id, title: "Café ☕" } }
        : { type: "event_callback", event_id: id, event: { type: "app_mention", text: "Café ☕" } },
    );
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(preset === "linear" ? body : `v0:${timestamp}:${body}`),
      ),
    );
    const hex = Array.from(signed, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const headers: Record<string, string> =
      preset === "linear"
        ? { "linear-signature": hex, "linear-delivery": id, "linear-event": "Issue" }
        : { "x-slack-signature": `v0=${hex}`, "x-slack-request-timestamp": timestamp };
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", ...headers },
      body: options.tamper ? `${body} ` : body,
    });
    return { id, status: response.status, body: await response.text() };
  });

const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  for (const preset of ["linear", "slack"] as const) {
    const name = `e2e-${preset}-${crypto.randomUUID().slice(0, 8)}`;
    // Linear's provider-issued signing secret is pasted; Slack exercises generation.
    const pasted = preset === "linear" ? crypto.randomUUID() : undefined;
    yield* Effect.acquireUseRelease(
      request("/api/connections", ConnectionCreated, {
        method: "POST",
        body: {
          kind: "inbound",
          name,
          signing: { kind: "preset", preset },
          ...(pasted === undefined ? {} : { secret: pasted }),
        },
      }),
      (connection) =>
        Effect.gen(function* () {
          if (connection.kind !== "inbound")
            return yield* failure(
              "signatures",
              "Expected an inbound connection",
              "scotty connections",
            );
          yield* check(
            pasted === undefined ? connection.secret !== null : connection.secret === null,
            "Pasted secrets must not be returned; generated secrets must be shown once",
          );
          const secret = pasted ?? connection.secret;
          if (secret === null)
            return yield* failure(
              "signatures",
              "Missing generated signing secret",
              "scotty connections",
            );
          const listed = yield* request("/api/connections", Connections);
          yield* check(
            listed.connections.some((item) => item.name === name && item.kind === "inbound") &&
              !JSON.stringify(listed).includes(secret),
            "Connection missing or its secret leaked in listing",
          );
          const valid = yield* deliver(connection.url, secret, preset);
          yield* check(valid.status === 200, `${preset}: valid delivery answered ${valid.status}`);
          yield* Schema.decodeUnknownEffect(Skipped)(valid.body);
          const tampered = yield* deliver(connection.url, secret, preset, { tamper: true });
          yield* check(
            tampered.status === 401,
            `${preset}: tampered delivery answered ${tampered.status}`,
          );
          yield* check(
            (yield* Schema.decodeUnknownEffect(Rejected)(tampered.body)).error.code ===
              "bad_signature",
            "Tampering did not report bad_signature",
          );
          const stale = yield* deliver(connection.url, secret, preset, { stale: true });
          yield* check(stale.status === 401, `${preset}: stale delivery answered ${stale.status}`);
          yield* check(
            (yield* Schema.decodeUnknownEffect(Rejected)(stale.body)).error.code ===
              "stale_timestamp",
            "Stale delivery did not report stale_timestamp",
          );
          const log = yield* request(`/api/deliveries?connection=${name}`, Deliveries);
          for (const [answer, outcome, reason] of [
            [valid, "skipped", "no_automation"],
            [tampered, "rejected", "bad_signature"],
            [stale, "rejected", "stale_timestamp"],
          ] as const)
            yield* check(
              log.deliveries.some(
                (item) =>
                  item.id === answer.id &&
                  item.outcome === outcome &&
                  item.reason === reason &&
                  item.session === null,
              ),
              `${preset}: ${reason} was not listed without a session`,
            );
          console.log(`${preset}: signed, tampered and stale deliveries recorded`);
        }),
      () =>
        request(`/api/connections/${name}`, ConnectionRemoved, { method: "DELETE" }).pipe(
          Effect.orDie,
        ),
    );
  }
});
Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Signatures e2e failed");
  process.exitCode = 1;
});
