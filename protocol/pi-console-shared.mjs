export const PI_SENTINEL_PREFIX = "scotty-pi-";
export const GITHUB_SENTINEL_PREFIX = "scotty-github-";
export const PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER = "x-scotty-internal-passive-no-heartbeat";
export const CREDENTIAL_SENTINEL_PREFIXES = Object.freeze([
  PI_SENTINEL_PREFIX,
  GITHUB_SENTINEL_PREFIX,
]);

const sentinelPattern = /(?:scotty-pi-|scotty-github-)[A-Za-z0-9_-]+/gu;

export const redactCredentialSentinels = (value) => value.replaceAll(sentinelPattern, "[sentinel]");

export const canonicalJson = (value) => {
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Canonical JSON value is not serializable");
  return encoded;
};

export const commandIntentDigest = async (intent) => {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(intent)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
