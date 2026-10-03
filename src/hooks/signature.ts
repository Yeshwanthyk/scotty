import { Option, Schema } from "effect";
import { field } from "../automations/automation.js";
import { signingKey, type InboundConfig } from "./config.js";

export const maxBodyBytes = 64 * 1024;
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const SigningValues = Schema.Struct({
  id: Text,
  event: Schema.NullOr(Text),
  timestamp: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  signature: Schema.String.check(Schema.isMinLength(1)),
});
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeValues = Schema.decodeUnknownOption(SigningValues);

export function readDelivery(
  config: InboundConfig,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
) {
  const payload = decodeJson(new TextDecoder().decode(body));
  if (Option.isNone(payload)) {
    const id =
      config.delivery.kind === "header" ? headers[config.delivery.name.toLowerCase()] : undefined;
    return {
      verdict: "bad_body",
      id: Option.getOrElse(Schema.decodeUnknownOption(Text)(id), () => ""),
    } as const;
  }
  const source = (location: typeof config.delivery): unknown =>
    location.kind === "header"
      ? headers[location.name.toLowerCase()]
      : field(payload.value, location.path);
  const id = source(config.delivery);
  const timestamp =
    config.timestamp === null ? null : (source(config.timestamp.source) ?? undefined);
  const checked = decodeValues({
    id,
    event: config.event === null ? null : (source(config.event) ?? undefined),
    timestamp: typeof timestamp === "number" ? String(timestamp) : timestamp,
    signature: headers[config.header.toLowerCase()],
  });
  if (Option.isNone(checked))
    return {
      verdict: "missing_headers",
      id: Option.getOrElse(Schema.decodeUnknownOption(Text)(id), () => ""),
    } as const;
  return { verdict: "ok", values: checked.value, payload: payload.value } as const;
}

const encoder = new TextEncoder();
const bytesOf = (base64: string): Uint8Array<ArrayBuffer> | undefined => {
  try {
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
};

export const newSecret = (prefix: string) => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `${prefix}${btoa(String.fromCharCode(...bytes))}`;
};

export async function verifySignature(
  config: InboundConfig,
  input: {
    secret: string;
    values: typeof SigningValues.Type;
    body: Uint8Array<ArrayBuffer>;
    now: number;
  },
): Promise<"ok" | "bad_signature" | "stale_timestamp"> {
  const { id, timestamp, signature } = input.values;
  if (config.timestamp !== null && (timestamp === null || !/^\d{1,16}$/.test(timestamp)))
    return "bad_signature";
  const raw = signingKey(config.key, input.secret);
  if (raw === undefined) return "bad_signature";
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  // Insert raw bytes, without decoding/re-encoding the body or interpreting values as templates.
  const parts = config.signed
    .split(/(\{id\}|\{timestamp\}|\{body\})/)
    .map((part) =>
      part === "{body}"
        ? input.body
        : encoder.encode(part === "{id}" ? id : part === "{timestamp}" ? (timestamp ?? "") : part),
    );
  const signed = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    signed.set(part, offset);
    offset += part.length;
  }
  // Space-separated candidates also cover Standard Webhooks' secret rotation.
  for (const entry of signature.split(" ")) {
    if (!entry.startsWith(config.prefix)) continue;
    const value = entry.slice(config.prefix.length);
    const candidate =
      config.encoding === "base64"
        ? bytesOf(value)
        : /^[0-9a-fA-F]{64}$/.test(value)
          ? Uint8Array.from({ length: 32 }, (_, index) =>
              Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
            )
          : undefined;
    // Web Crypto compares HMACs in constant time.
    if (candidate === undefined || !(await crypto.subtle.verify("HMAC", key, candidate, signed)))
      continue;
    if (config.timestamp !== null && config.timestamp.toleranceSeconds !== undefined) {
      const at = Number(timestamp) * (config.timestamp.unit === "seconds" ? 1000 : 1);
      if (Math.abs(input.now - at) > config.timestamp.toleranceSeconds * 1000)
        return "stale_timestamp";
    }
    return "ok";
  }
  return "bad_signature";
}
