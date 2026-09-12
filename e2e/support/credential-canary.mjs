export const AMBIENT_CREDENTIAL_ENV_NAMES = Object.freeze([
  "GH_TOKEN",
  "PI_AUTH_JSON",
  "CREDENTIAL_WRAPPING_KEY",
]);

export function withoutAmbientCredentialEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !AMBIENT_CREDENTIAL_ENV_NAMES.includes(name)),
  );
}

export function scrubAmbientCredentialEnvironment(source = process.env) {
  return {
    ...withoutAmbientCredentialEnvironment(source),
    GH_TOKEN: undefined,
    PI_AUTH_JSON: undefined,
    CREDENTIAL_WRAPPING_KEY: undefined,
  };
}

function stringValues(value, output) {
  if (typeof value === "string") {
    if (value.length >= 8) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringValues(item, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) stringValues(item, output);
  }
}

export function credentialCanaryValues({ piAuthJson, githubToken, wrappingKey }) {
  const values = new Set();
  if (typeof piAuthJson === "string" && piAuthJson.length > 0) {
    values.add(piAuthJson);
    try {
      stringValues(JSON.parse(piAuthJson), values);
    } catch {}
  }
  for (const value of [githubToken, wrappingKey])
    if (typeof value === "string" && value.length > 0) values.add(value);
  return [...values].sort((left, right) => right.length - left.length);
}

export function findCredentialLeaks(value, secrets) {
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  return secrets.filter(
    (secret) => typeof secret === "string" && secret.length > 0 && text.includes(secret),
  );
}
