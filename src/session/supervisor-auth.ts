const encoder = new TextEncoder();

const sign: (
  key: Uint8Array<ArrayBuffer>,
  data: string,
) => Promise<Uint8Array<ArrayBuffer>> = async (key, data) =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      encoder.encode(data),
    ),
  );

export const hex: (bytes: Uint8Array) => string = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const sessionKey: (secret: string, session: string) => Promise<Uint8Array<ArrayBuffer>> = (
  secret,
  session,
) => sign(encoder.encode(secret), session);

export const callerProof: (key: Uint8Array<ArrayBuffer>, gen: number) => Promise<string> = async (
  key,
  gen,
) => hex(await sign(key, String(gen)));
