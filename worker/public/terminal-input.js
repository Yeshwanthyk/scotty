export function composerText(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/gu, "\n");
  return normalized.trim().length > 0 ? normalized : undefined;
}

export function hasAvailableRuntime(projection) {
  return (projection?.capabilities?.models?.length ?? 0) > 0;
}
