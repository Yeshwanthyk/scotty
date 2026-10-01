import {
  auth,
  checkResourceAllowed,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";
import { Effect, Schema } from "effect";
import { ConnectionSecret, ConnectionUrl } from "./connections.js";

const Strings = Schema.mutable(Schema.Array(Schema.String));
const Metadata = Schema.Struct({
  issuer: ConnectionUrl,
  authorization_endpoint: ConnectionUrl,
  token_endpoint: ConnectionUrl,
  registration_endpoint: Schema.optionalKey(ConnectionUrl),
  response_types_supported: Strings,
  scopes_supported: Schema.optionalKey(Strings),
  grant_types_supported: Schema.optionalKey(Strings),
  token_endpoint_auth_methods_supported: Schema.optionalKey(Strings),
  code_challenge_methods_supported: Schema.optionalKey(Strings),
  authorization_response_iss_parameter_supported: Schema.optionalKey(Schema.Boolean),
});
const Discovery = Schema.Struct({
  authorizationServerUrl: ConnectionUrl,
  authorizationServerMetadata: Metadata,
  resourceMetadataUrl: Schema.optionalKey(ConnectionUrl),
  resourceMetadata: Schema.optionalKey(
    Schema.Struct({
      resource: ConnectionUrl,
      authorization_servers: Schema.optionalKey(Schema.mutable(Schema.Array(ConnectionUrl))),
      scopes_supported: Schema.optionalKey(Strings),
    }),
  ),
});
const Client = Schema.Struct({
  client_id: Schema.String.check(Schema.isMinLength(1)),
  client_secret: Schema.optionalKey(Schema.String),
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
  issuer: ConnectionUrl,
});
const Tokens = Schema.Struct({
  access_token: ConnectionSecret,
  token_type: Schema.String.check(Schema.makeFilter((value) => value.toLowerCase() === "bearer")),
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
  scope: Schema.optionalKey(Schema.String),
  issuer: Schema.optionalKey(ConnectionUrl),
});
const context = {
  client: Client,
  discovery: Discovery,
  redirectUrl: ConnectionUrl,
  resource: ConnectionUrl,
};
const Pending = Schema.Struct({
  phase: Schema.Literal("pending"),
  ...context,
  verifier: Schema.String,
});
const SignedIn = Schema.Struct({
  phase: Schema.Literal("signed-in"),
  ...context,
  tokens: Tokens,
  expiresAt: Schema.Number,
});
export const StoredMcpOAuth = Schema.Union([Pending, SignedIn]);
export type StoredMcpOAuth = typeof StoredMcpOAuth.Type;
class McpOAuthFailure extends Schema.TaggedError<McpOAuthFailure>()("McpOAuthFailure", {}) {}

// The SDK's fetch hook is a host boundary. Refuse redirects before credentials can cross hosts.
const oauthFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw new McpOAuthFailure({});
  return response;
};

export const authorizeMcp = (
  serverUrl: string,
  input:
    | { kind: "connect"; redirectUrl: string; nonce: string; previous: StoredMcpOAuth | null }
    | { kind: "callback"; pending: typeof Pending.Type; code: string; iss?: string },
) =>
  Effect.tryPromise({
    try: async () => {
      const redirectUrl = input.kind === "connect" ? input.redirectUrl : input.pending.redirectUrl;
      let client = input.kind === "connect" ? input.previous?.client : input.pending.client;
      let discovery = input.kind === "connect" ? undefined : input.pending.discovery;
      let verifier = input.kind === "connect" ? undefined : input.pending.verifier;
      let tokens: typeof Tokens.Type | undefined;
      let authorizationUrl: string | undefined;
      let resource = input.kind === "connect" ? serverUrl : input.pending.resource;
      const provider: OAuthClientProvider = {
        redirectUrl,
        clientMetadata: {
          client_name: "Scotty",
          redirect_uris: [redirectUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        saveResourceUrl: (value) => {
          resource = Schema.decodeUnknownSync(ConnectionUrl)(value);
        },
        state: () => (input.kind === "connect" ? input.nonce : ""),
        clientInformation: () => client,
        saveClientInformation: (value) => {
          client = Schema.decodeUnknownSync(Client)(value);
        },
        discoveryState: () => discovery,
        saveDiscoveryState: (value) => {
          discovery = Schema.decodeUnknownSync(Discovery)(value);
        },
        tokens: () => undefined,
        saveTokens: (value) => {
          tokens = Schema.decodeUnknownSync(Tokens)(value);
        },
        saveCodeVerifier: (value) => {
          verifier = value;
        },
        codeVerifier: () => {
          if (verifier === undefined) throw new McpOAuthFailure({});
          return verifier;
        },
        redirectToAuthorization: (value) => {
          authorizationUrl = Schema.decodeUnknownSync(ConnectionUrl)(value.href);
        },
        validateResourceURL: async (url, resource) => {
          if (
            resource !== undefined &&
            !checkResourceAllowed({ requestedResource: new URL(url), configuredResource: resource })
          )
            throw new McpOAuthFailure({});
          return new URL(resource ?? url);
        },
        invalidateCredentials: () => {
          throw new McpOAuthFailure({});
        },
      };
      let resourceMetadataUrl: URL | undefined;
      if (input.kind === "connect") {
        const probe = await oauthFetch(serverUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "scotty-connect",
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "Scotty", version: "1" },
            },
          }),
        });
        const challenge = extractWWWAuthenticateParams(probe);
        if (challenge.resourceMetadataUrl !== undefined)
          resourceMetadataUrl = new URL(
            Schema.decodeUnknownSync(ConnectionUrl)(challenge.resourceMetadataUrl.href),
          );
        await probe.body?.cancel();
      }
      const result = await auth(provider, {
        serverUrl,
        fetchFn: oauthFetch,
        ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
        ...(input.kind === "callback" ? { authorizationCode: input.code, iss: input.iss } : {}),
      });
      if (client === undefined || discovery === undefined) throw new McpOAuthFailure({});
      if (result === "REDIRECT" && verifier !== undefined && authorizationUrl !== undefined)
        return {
          kind: "redirect" as const,
          authorizationUrl,
          stored: Schema.decodeUnknownSync(Pending)({
            phase: "pending",
            client,
            discovery,
            redirectUrl,
            resource,
            verifier,
          }),
        };
      if (result === "AUTHORIZED" && tokens !== undefined)
        return {
          kind: "authorized" as const,
          stored: Schema.decodeUnknownSync(SignedIn)({
            phase: "signed-in",
            client,
            discovery,
            redirectUrl,
            resource,
            tokens,
            expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          }),
        };
      throw new McpOAuthFailure({});
    },
    catch: () => new McpOAuthFailure({}),
  });

export const refreshMcp = (stored: typeof SignedIn.Type) =>
  Effect.tryPromise({
    try: async () => {
      if (stored.tokens.refresh_token === undefined) throw new McpOAuthFailure({});
      const tokens = Schema.decodeUnknownSync(Tokens)(
        await refreshAuthorization(stored.discovery.authorizationServerUrl, {
          metadata: stored.discovery.authorizationServerMetadata,
          clientInformation: stored.client,
          refreshToken: stored.tokens.refresh_token,
          resource: new URL(stored.resource),
          fetchFn: oauthFetch,
        }),
      );
      return { ...stored, tokens, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 };
    },
    catch: () => new McpOAuthFailure({}),
  });
