import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ConnectionUrl } from "../src/creds/connections.js";

const Registration = Schema.Struct({ redirect_uris: Schema.Array(ConnectionUrl) });
const Authorization = Schema.Struct({
  client_id: Schema.String,
  redirect_uri: ConnectionUrl,
  state: Schema.String,
  response_type: Schema.Literal("code"),
  code_challenge: Schema.String,
  code_challenge_method: Schema.Literal("S256"),
  resource: ConnectionUrl,
});
const Grant = Schema.Union([
  Schema.Struct({
    grant_type: Schema.Literal("authorization_code"),
    client_id: Schema.String,
    code: Schema.String,
    code_verifier: Schema.String,
    redirect_uri: ConnectionUrl,
    resource: ConnectionUrl,
  }),
  Schema.Struct({
    grant_type: Schema.Literal("refresh_token"),
    client_id: Schema.String,
    refresh_token: Schema.String,
    resource: ConnectionUrl,
  }),
]);
const Rpc = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
const ToolCall = Schema.Struct({ name: Schema.Literals(["read", "write"]) });
const ClientRow = Schema.Struct({ redirect: Schema.String });
const CodeRow = Schema.Struct({
  client: Schema.String,
  redirect: Schema.String,
  challenge: Schema.String,
  resource: Schema.String,
});
const TokenRow = Schema.Struct({
  client: Schema.String,
  resource: Schema.String,
  generation: Schema.Number,
  expires: Schema.Number,
  writes: Schema.Number,
});
const nonce = () => crypto.randomUUID();
const expirySeconds = 70;

export class McpTestObject extends Cloudflare.DurableObject<McpTestObject>()(
  "McpTestObject",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const ownerHost = yield* Config.String("SCOTTY_HOST");
      const sql = yield* SqliteClient.SqliteClient;
      yield* sql`CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, redirect TEXT NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, client TEXT NOT NULL, redirect TEXT NOT NULL, challenge TEXT NOT NULL, resource TEXT NOT NULL)`;
      yield* sql`CREATE TABLE IF NOT EXISTS tokens (access TEXT PRIMARY KEY, refresh TEXT UNIQUE NOT NULL, client TEXT NOT NULL, resource TEXT NOT NULL, generation INTEGER NOT NULL, expires INTEGER NOT NULL, writes INTEGER NOT NULL)`;
      const unavailable = new Set<string>();
      const nonRotating = new Set<string>();
      const unauthorized = new Map<string, number>();
      return {
        fetch: (request: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
            const url = new URL(request.originalUrl);
            const origin = url.origin;
            const resource = `${origin}/mcp`;
            const validRedirect = (redirect: string) =>
              new URL(redirect).host === ownerHost &&
              /^\/api\/connections\/[a-z0-9-]+\/callback$/.test(new URL(redirect).pathname);
            if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
              return yield* HttpServerResponse.json({
                resource,
                authorization_servers: [origin],
                scopes_supported: ["tools"],
              });
            if (url.pathname === "/.well-known/oauth-authorization-server")
              return yield* HttpServerResponse.json({
                issuer: origin,
                authorization_endpoint: `${origin}/authorize`,
                token_endpoint: `${origin}/token`,
                registration_endpoint: `${origin}/register`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
                authorization_response_iss_parameter_supported: true,
              });
            if (url.pathname === "/register" && request.method === "POST") {
              const registration = yield* Schema.decodeUnknownEffect(Registration)(
                yield* request.json,
              );
              const redirect = registration.redirect_uris[0];
              if (redirect === undefined || !validRedirect(redirect))
                return yield* HttpServerResponse.json(
                  { error: "invalid_redirect_uri" },
                  { status: 400 },
                );
              const client = nonce();
              yield* sql`INSERT INTO clients (id, redirect) VALUES (${client}, ${redirect})`;
              return yield* HttpServerResponse.json(
                {
                  client_id: client,
                  redirect_uris: [redirect],
                  token_endpoint_auth_method: "none",
                },
                { status: 201 },
              );
            }
            if (url.pathname === "/authorize" && request.method === "GET") {
              const query = yield* Schema.decodeUnknownEffect(Authorization)(
                Object.fromEntries(url.searchParams),
              );
              const row =
                (yield* sql`SELECT redirect FROM clients WHERE id = ${query.client_id}`)[0];
              const registered =
                row === undefined ? null : yield* Schema.decodeUnknownEffect(ClientRow)(row);
              if (
                registered === null ||
                registered.redirect !== query.redirect_uri ||
                query.resource !== resource
              )
                return HttpServerResponse.text("Invalid client", { status: 400 });
              const code = nonce();
              yield* sql`INSERT INTO codes (code, client, redirect, challenge, resource) VALUES (${code}, ${query.client_id}, ${query.redirect_uri}, ${query.code_challenge}, ${query.resource})`;
              const redirect = new URL(query.redirect_uri);
              redirect.searchParams.set("code", code);
              redirect.searchParams.set("state", query.state);
              redirect.searchParams.set("iss", origin);
              return HttpServerResponse.empty({
                status: 302,
                headers: { location: redirect.href },
              });
            }
            if (url.pathname === "/token" && request.method === "POST") {
              const grant = yield* Schema.decodeUnknownEffect(Grant)(
                Object.fromEntries(new URLSearchParams(yield* request.text)),
              );
              let generation = 1;
              let writes = 0;
              let refresh = `mcp-oauth-refresh-${nonce()}`;
              if (grant.grant_type === "authorization_code") {
                const row =
                  (yield* sql`DELETE FROM codes WHERE code = ${grant.code} RETURNING client, redirect, challenge, resource`)[0];
                const code =
                  row === undefined ? null : yield* Schema.decodeUnknownEffect(CodeRow)(row);
                const digest = yield* Effect.promise(() =>
                  crypto.subtle.digest("SHA-256", new TextEncoder().encode(grant.code_verifier)),
                );
                const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
                  .replaceAll("+", "-")
                  .replaceAll("/", "_")
                  .replace(/=+$/, "");
                if (
                  code === null ||
                  code.client !== grant.client_id ||
                  code.redirect !== grant.redirect_uri ||
                  code.resource !== grant.resource ||
                  code.challenge !== challenge
                )
                  return yield* HttpServerResponse.json(
                    { error: "invalid_grant" },
                    { status: 400 },
                  );
              } else {
                if (unavailable.delete(grant.client_id))
                  return yield* HttpServerResponse.json({ error: "server_error" }, { status: 503 });
                const row =
                  (yield* sql`DELETE FROM tokens WHERE refresh = ${grant.refresh_token} AND client = ${grant.client_id} AND resource = ${grant.resource} RETURNING client, resource, generation, expires, writes`)[0];
                const old =
                  row === undefined ? null : yield* Schema.decodeUnknownEffect(TokenRow)(row);
                if (old === null)
                  return yield* HttpServerResponse.json(
                    { error: "invalid_grant" },
                    { status: 400 },
                  );
                generation = old.generation + 1;
                writes = old.writes;
                if (nonRotating.has(grant.client_id)) refresh = grant.refresh_token;
              }
              const access = `mcp-oauth-access-${nonce()}`;
              yield* sql`INSERT INTO tokens (access, refresh, client, resource, generation, expires, writes) VALUES (${access}, ${refresh}, ${grant.client_id}, ${grant.resource}, ${generation}, ${Date.now() + expirySeconds * 1000}, ${writes})`;
              return yield* HttpServerResponse.json({
                access_token: access,
                ...(grant.grant_type === "refresh_token" && nonRotating.has(grant.client_id)
                  ? {}
                  : { refresh_token: refresh }),
                token_type: "Bearer",
                expires_in: expirySeconds,
              });
            }
            if (url.pathname === "/configure" && request.method === "POST") {
              const { client, mode } = yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                  client: Schema.String,
                  mode: Schema.Literals(["unavailable", "non-rotating", "unauthorized"]),
                }),
              )(yield* request.json);
              if (mode === "unavailable") unavailable.add(client);
              if (mode === "non-rotating") nonRotating.add(client);
              if (mode === "unauthorized")
                yield* sql`UPDATE tokens SET expires = 0 WHERE client = ${client}`;
              return HttpServerResponse.empty();
            }
            if (url.pathname === "/invalidate" && request.method === "POST") {
              const { client } = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ client: Schema.String }),
              )(yield* request.json);
              yield* sql`UPDATE tokens SET refresh = ${nonce()} WHERE client = ${client}`;
              return HttpServerResponse.empty();
            }
            if (url.pathname === "/mcp") {
              const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
              const row =
                (yield* sql`SELECT client, resource, generation, expires, writes FROM tokens WHERE access = ${token}`)[0];
              const credential =
                row === undefined ? null : yield* Schema.decodeUnknownEffect(TokenRow)(row);
              if (credential?.expires === 0)
                unauthorized.set(credential.client, (unauthorized.get(credential.client) ?? 0) + 1);
              if (credential === null || credential.expires <= Date.now())
                return HttpServerResponse.empty({
                  status: 401,
                  headers: {
                    "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
                  },
                });
              if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
              const rpc = yield* Schema.decodeUnknownEffect(Rpc)(yield* request.json);
              if (
                request.headers["mcp-method"] !== rpc.method ||
                (rpc.method === "tools/list" && request.headers["mcp-name"] !== undefined)
              )
                return yield* HttpServerResponse.json(
                  { error: "invalid_request" },
                  { status: 400 },
                );
              if (rpc.id === undefined) return HttpServerResponse.empty({ status: 202 });
              let result: unknown;
              if (rpc.method === "initialize")
                result = {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "scotty-oauth-test", version: "1" },
                };
              else if (rpc.method === "tools/list")
                result = {
                  tools: [
                    {
                      name: "read",
                      description: "Read test generation",
                      inputSchema: { type: "object" },
                      annotations: { readOnlyHint: true },
                    },
                    {
                      name: "write",
                      description: "Count a test write",
                      inputSchema: { type: "object" },
                      annotations: { readOnlyHint: false },
                    },
                  ],
                };
              else if (rpc.method.toLowerCase() === "tools/call") {
                const params = yield* Schema.decodeUnknownEffect(ToolCall)(rpc.params);
                if (params.name === "write")
                  yield* sql`UPDATE tokens SET writes = writes + 1 WHERE access = ${token}`;
                result = {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        generation: credential.generation,
                        writes: credential.writes + (params.name === "write" ? 1 : 0),
                        unauthorized: unauthorized.get(credential.client) ?? 0,
                      }),
                    },
                  ],
                };
              } else result = {};
              const message = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
              if (request.headers["x-test-sse"] === "yes") {
                const encoder = new TextEncoder();
                const payload = `: test\r\nid: event-${rpc.id}\r\nevent: message\r\ndata: ${message}\r\n\r\n`;
                return HttpServerResponse.fromWeb(
                  new Response(
                    new ReadableStream<Uint8Array<ArrayBuffer>>({
                      start(controller) {
                        for (let offset = 0; offset < payload.length; offset += 7)
                          controller.enqueue(encoder.encode(payload.slice(offset, offset + 7)));
                        controller.close();
                      },
                    }),
                    { headers: { "content-type": "text/event-stream" } },
                  ),
                );
              }
              return HttpServerResponse.text(message, { contentType: "application/json" });
            }
            return HttpServerResponse.text("Not found", { status: 404 });
          }).pipe(
            Effect.catchTag("SchemaError", () =>
              HttpServerResponse.json({ error: "invalid_request" }, { status: 400 }),
            ),
          ),
      };
    }).pipe(Effect.provide(SqliteClient.layer({ storage: state.raw.storage })), Effect.orDie);
  }),
) {}

export default class McpTestWorker extends Cloudflare.Worker<McpTestWorker>()(
  "McpTestWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const server = yield* McpTestObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* server.getByName("test").fetch(request).pipe(Effect.orDie);
      }),
    };
  }),
) {}
