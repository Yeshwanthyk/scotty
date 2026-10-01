import { Schema } from "effect";
import {
  CustomInboundConfig,
  InboundConfig,
  SignaturePreset,
  signaturePresets,
  signingKey,
} from "../hooks/config.js";

// Lowercase and explicit: the name is in the hook URL and in every session it starts.
export const connectionName = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ConnectionName = Schema.String.check(Schema.isPattern(connectionName));
export const InternalConnectionName = ConnectionName.check(
  Schema.makeFilter((name: string) => !["github", "files", "scotty", "run"].includes(name)),
);

export const ConnectionHost = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(/^[A-Za-z0-9.[\]:-]+$/),
  Schema.makeFilter((host: string) => {
    try {
      return new URL(`https://${host}`).hostname !== "";
    } catch {
      return false;
    }
  }),
);
// A header name, optionally followed by its scheme: `Authorization: Bearer` or `X-Api-Key`.
export const ConnectionHeader = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:: [A-Za-z][A-Za-z0-9_-]*)?$/),
  Schema.makeFilter(
    (header: string) =>
      ![
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "cookie",
        "proxy-authorization",
        "upgrade",
        "te",
        "trailer",
        "keep-alive",
      ].includes(header.split(":")[0]?.toLowerCase() ?? ""),
  ),
);
export const ConnectionUrl = Schema.String.check(
  Schema.makeFilter((value: string) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === ""
      );
    } catch {
      return false;
    }
  }),
);
const Secret = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8192),
  Schema.isPattern(/^[\x21-\x7e]+$/),
);
export const ConnectionConfig = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("inbound"), signature: InboundConfig }),
  Schema.Struct({ kind: Schema.Literal("token"), host: ConnectionHost, header: ConnectionHeader }),
  Schema.Struct({ kind: Schema.Literal("mcp"), url: ConnectionUrl }),
]);
export const NewConnection = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("inbound"),
    name: ConnectionName,
    signing: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("preset"), preset: SignaturePreset }),
      Schema.Struct({ kind: Schema.Literal("custom"), config: CustomInboundConfig }),
    ]),
    secret: Schema.optional(Secret),
  }).check(
    Schema.makeFilter(
      (input) =>
        input.secret === undefined ||
        signingKey(
          input.signing.kind === "preset"
            ? signaturePresets[input.signing.preset].key
            : input.signing.config.key,
          input.secret,
        ) !== undefined,
      {
        message:
          "Signing key must be nonempty raw text or the configured prefix followed by nonempty valid base64 bytes",
      },
    ),
  ),
  Schema.Struct({
    kind: Schema.Literal("token"),
    name: InternalConnectionName,
    host: ConnectionHost,
    header: ConnectionHeader,
    secret: Secret,
  }),
  Schema.Struct({
    kind: Schema.Literal("mcp"),
    name: InternalConnectionName,
    url: ConnectionUrl,
    secret: Secret,
  }),
]);
export const configFor = (input: typeof NewConnection.Type): typeof ConnectionConfig.Type => {
  switch (input.kind) {
    case "inbound":
      return {
        kind: input.kind,
        signature:
          input.signing.kind === "preset"
            ? signaturePresets[input.signing.preset]
            : input.signing.config,
      };
    case "token":
      return { kind: input.kind, host: input.host, header: input.header };
    case "mcp":
      return { kind: input.kind, url: input.url };
  }
};
const metadata = { name: ConnectionName, created: Schema.Number };
export type ConnectionMetadata = typeof ConnectionConfig.Type & {
  readonly name: string;
  readonly created: number;
};
export const internalUrl = (name: string, kind: "token" | "mcp") =>
  `http://${name}.internal/api/${kind === "mcp" ? "mcp" : ""}`;
export const connectionView = (connection: ConnectionMetadata, origin: string) =>
  connection.kind === "inbound"
    ? { ...connection, url: `${origin}/hooks/${connection.name}` }
    : { ...connection, internalUrl: internalUrl(connection.name, connection.kind) };
const Inbound = Schema.Struct({
  ...metadata,
  ...ConnectionConfig.members[0].fields,
  url: Schema.String,
});
const Token = Schema.Struct({
  ...metadata,
  kind: Schema.Literal("token"),
  host: ConnectionHost,
  header: ConnectionHeader,
  internalUrl: Schema.String,
});
const Mcp = Schema.Struct({
  ...metadata,
  kind: Schema.Literal("mcp"),
  url: ConnectionUrl,
  internalUrl: Schema.String,
});
export const Connection = Schema.Union([Inbound, Token, Mcp]);
export const ConnectionCreated = Schema.Union([
  Schema.Struct({ ...Inbound.fields, secret: Schema.NullOr(Schema.String) }),
  Token,
  Mcp,
]);

// A key ties deliveries (or API creates) to one session.
export const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const DeliveryOutcome = Schema.Literals(["accepted", "rejected", "duplicate", "skipped"]);
// Why a delivery was rejected or skipped; the UI and CLI decode these same codes.
export const DeliveryReason = Schema.Literals([
  "missing_headers",
  "unknown_connection",
  "own_github_identity",
  "no_automation",
  "too_large",
  "bad_signature",
  "stale_timestamp",
  "bad_body",
  "repository_not_found",
  "repository_unavailable",
  "key_conflict",
  "session_unavailable",
]);
// How many deliveries are kept; older ones are dropped as new ones arrive.
export const keptDeliveries = 500;
