import { Schema } from "effect";

const Header = Schema.String.check(
  Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  Schema.isMaxLength(256),
);
const Path = Schema.String.check(
  Schema.isPattern(/^[^\s.{}]+(?:\.[^\s.{}]+)*$/),
  Schema.isMaxLength(256),
);
const Source = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("header"), name: Header }),
  Schema.Struct({ kind: Schema.Literal("payload"), path: Path }),
]);

export const InboundConfig = Schema.Struct({
  header: Header,
  prefix: Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[^\s]*$/)),
  encoding: Schema.Literals(["hex", "base64"]),
  signed: Schema.String.check(
    Schema.isMaxLength(256),
    Schema.isPattern(/^(?:[^{}]|\{(?:id|timestamp|body)\})+$/),
    Schema.makeFilter((value) => value.split("{body}").length === 2),
  ),
  key: Schema.Union([
    Schema.Struct({ encoding: Schema.Literal("raw") }),
    Schema.Struct({ encoding: Schema.Literal("base64"), prefix: Schema.String }),
  ]),
  delivery: Source,
  event: Schema.NullOr(Source),
  timestamp: Schema.NullOr(
    Schema.Struct({
      source: Source,
      unit: Schema.Literals(["seconds", "milliseconds"]),
      toleranceSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    }),
  ),
  selfEvent: Schema.NullOr(Schema.Struct({ path: Path, identity: Schema.Literal("github-login") })),
  unhandled: Schema.Literals(["session", "skip"]),
}).check(
  Schema.makeFilter(
    (config) => !config.signed.includes("{timestamp}") || config.timestamp !== null,
  ),
);
export type InboundConfig = typeof InboundConfig.Type;

export const SignaturePreset = Schema.Literals(["standard-webhooks", "github", "linear", "slack"]);
export type SignaturePreset = typeof SignaturePreset.Type;
export const signaturePresets = {
  "standard-webhooks": {
    header: "webhook-signature",
    prefix: "v1,",
    encoding: "base64",
    signed: "{id}.{timestamp}.{body}",
    key: { encoding: "base64", prefix: "whsec_" },
    delivery: { kind: "header", name: "webhook-id" },
    event: null,
    timestamp: {
      source: { kind: "header", name: "webhook-timestamp" },
      unit: "seconds",
      toleranceSeconds: 300,
    },
    selfEvent: null,
    unhandled: "session",
  },
  github: {
    header: "x-hub-signature-256",
    prefix: "sha256=",
    encoding: "hex",
    signed: "{body}",
    key: { encoding: "raw" },
    delivery: { kind: "header", name: "x-github-delivery" },
    event: { kind: "header", name: "x-github-event" },
    timestamp: null,
    selfEvent: { path: "sender.login", identity: "github-login" },
    unhandled: "skip",
  },
  linear: {
    header: "linear-signature",
    prefix: "",
    encoding: "hex",
    signed: "{body}",
    key: { encoding: "raw" },
    delivery: { kind: "header", name: "linear-delivery" },
    event: { kind: "header", name: "linear-event" },
    timestamp: {
      source: { kind: "payload", path: "webhookTimestamp" },
      unit: "milliseconds",
      toleranceSeconds: 60,
    },
    selfEvent: null,
    unhandled: "skip",
  },
  slack: {
    header: "x-slack-signature",
    prefix: "v0=",
    encoding: "hex",
    signed: "v0:{timestamp}:{body}",
    key: { encoding: "raw" },
    delivery: { kind: "payload", path: "event_id" },
    event: { kind: "payload", path: "event.type" },
    timestamp: {
      source: { kind: "header", name: "x-slack-request-timestamp" },
      unit: "seconds",
      toleranceSeconds: 300,
    },
    selfEvent: null,
    unhandled: "skip",
  },
} satisfies Record<SignaturePreset, InboundConfig>;
