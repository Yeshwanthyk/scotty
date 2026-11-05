// The supervisor checks its caller (protocol/supervisor.ts `supervisorAuthHeader`). Each session's
// container is given k = HMAC-SHA256(Worker secret, session id) at create, as hex; every call for
// a generation carries hex HMAC-SHA256(k, String(gen)), keyed with k's 32 bytes.
const encoder = new TextEncoder();

const sign = async (key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      encoder.encode(data),
    ),
  );

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const sessionKey = (secret: string, session: string): Promise<Uint8Array<ArrayBuffer>> =>
  sign(encoder.encode(secret), session);

export const callerProof = async (key: Uint8Array<ArrayBuffer>, gen: number): Promise<string> =>
  hex(await sign(key, String(gen)));
