export const FAILURE_OUTPUT_TAIL_CHARACTERS = 64 * 1_024;

const CLOUDFLARE_ACCOUNT_ID = /\b[0-9a-f]{32}\b/giu;
const CLOUDFLARE_WORKER_URL = /https:\/\/[^\s'"`]+\.workers\.dev(?:\/[^\s'"`]*)?/giu;
const RESOURCE_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const AUTHORIZATION_VALUE =
  /(["']?\b(?:authorization|cf-aig-authorization)\b["']?\s*[:=]\s*)["']?(?:Bearer|Basic)\s+[^\s"',}\]]+["']?/giu;
const CREDENTIAL_VALUE =
  /(["']?\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|api[_-]?token|access[_-]?key|access[_-]?token|auth|key|password|refresh[_-]?token|secret(?:[_-]?access)?[_-]?key|token)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}[\]]+)/giu;

const CONFIRMED_RESOURCE_KEYS = Object.freeze([
  "worker",
  "runnerWorker",
  "container",
  "kv",
  "r2",
  "artifacts",
  "sandboxBundles",
  "previewBase",
  "previewZone",
]);

export function redactProductionDeploymentOutput(
  value: unknown,
  environment: Record<string, string | undefined> = {},
  secrets: ReadonlyArray<string> = [],
): string {
  let redacted = String(value);
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[redacted-secret]");
  }
  for (const [key, secret] of Object.entries(environment)) {
    if (
      /(?:AUTH|KEY|PASSWORD|SECRET|TOKEN)/iu.test(key) &&
      typeof secret === "string" &&
      secret.length > 0
    ) {
      redacted = redacted.replaceAll(secret, "[redacted-secret]");
    }
  }
  const confirmation = environment.SCOTTY_CLOUDFLARE_RESOURCES_CONFIRMED ?? "";
  for (const field of confirmation.split(":")) {
    const separator = field.indexOf("=");
    if (separator === -1) continue;
    const key = field.slice(0, separator);
    const resourceName = field.slice(separator + 1);
    if (!CONFIRMED_RESOURCE_KEYS.includes(key) || !resourceName) continue;
    redacted = redacted.replaceAll(resourceName, `[redacted-${key}]`);
  }
  return redacted
    .replaceAll(AUTHORIZATION_VALUE, "$1[redacted-secret]")
    .replaceAll(CREDENTIAL_VALUE, "$1[redacted-secret]")
    .replaceAll(CLOUDFLARE_WORKER_URL, "[redacted-worker-url]")
    .replaceAll(CLOUDFLARE_ACCOUNT_ID, "[redacted-account-id]")
    .replaceAll(RESOURCE_ID, "[redacted-resource-id]");
}
