import { Schema } from "effect";

// Standard Webhooks (https://www.standardwebhooks.com): the signature is
// base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)) under `v1,`, and the key is the base64
// after `whsec_` in the secret.
export const secretPrefix = "whsec_";
export const maxSkewSeconds = 5 * 60;
export const maxBodyBytes = 64 * 1024;

// The headers each sender signs with, decoded where the request enters.
const DeliveryId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const SigningHeaders = Schema.Union([
  Schema.Struct({
    kind: Schema.tagDefaultOmit("webhook"),
    id: DeliveryId,
    timestamp: Schema.String.check(Schema.isMinLength(1)),
    signature: Schema.String.check(Schema.isMinLength(1)),
  }).pipe(
    Schema.encodeKeys({
      id: "webhook-id",
      timestamp: "webhook-timestamp",
      signature: "webhook-signature",
    }),
  ),
  Schema.Struct({
    kind: Schema.tagDefaultOmit("github"),
    id: DeliveryId,
    event: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    signature: Schema.String.check(Schema.isMinLength(1)),
  }).pipe(
    Schema.encodeKeys({
      id: "x-github-delivery",
      event: "x-github-event",
      signature: "x-hub-signature-256",
    }),
  ),
]);
export type SigningHeaders = typeof SigningHeaders.Type;

const encoder = new TextEncoder();

const bytesOf = (base64: string): Uint8Array<ArrayBuffer> | undefined => {
  try {
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
};

export const newSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `${secretPrefix}${btoa(String.fromCharCode(...bytes))}`;
};

export type Verdict = "ok" | "bad_signature" | "stale_timestamp";

export async function verifyWebhook(input: {
  secret: string;
  id: string;
  timestamp: string;
  signature: string;
  body: string;
  now: number;
}): Promise<Verdict> {
  if (!/^\d{1,12}$/.test(input.timestamp)) return "bad_signature";
  if (Math.abs(input.now / 1000 - Number(input.timestamp)) > maxSkewSeconds)
    return "stale_timestamp";
  const raw = input.secret.startsWith(secretPrefix)
    ? bytesOf(input.secret.slice(secretPrefix.length))
    : undefined;
  if (raw === undefined) return "bad_signature";
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const signed = encoder.encode(`${input.id}.${input.timestamp}.${input.body}`);
  // The header may carry several signatures (a secret being rotated), each `v1,<base64>`.
  for (const entry of input.signature.split(" ")) {
    const [version, value] = entry.split(",");
    const candidate = version === "v1" && value !== undefined ? bytesOf(value) : undefined;
    // `verify` compares in constant time.
    if (candidate !== undefined && (await crypto.subtle.verify("HMAC", key, candidate, signed)))
      return "ok";
  }
  return "bad_signature";
}

export async function verifyGitHub(input: {
  secret: string;
  signature: string;
  body: Uint8Array<ArrayBuffer>;
}): Promise<Verdict> {
  if (!/^sha256=[0-9a-fA-F]{64}$/.test(input.signature)) return "bad_signature";
  const candidate = Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(input.signature.slice(7 + index * 2, 9 + index * 2), 16),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return (await crypto.subtle.verify("HMAC", key, candidate, input.body)) ? "ok" : "bad_signature";
}
