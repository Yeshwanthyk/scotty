export function statsResponse(value) {
  if (!isObject(value) || !(value.trackingSince === null || isTimestamp(value.trackingSince)))
    return undefined;
  if (!isObject(value.overall) || !Array.isArray(value.projects)) return undefined;

  const overall = statsCounts(value.overall, true);
  if (!overall) return undefined;
  const projects = [];
  for (const candidate of value.projects) {
    if (!isObject(candidate)) return undefined;
    const repository = repositoryName(candidate.repository);
    const counts = statsCounts(candidate, false);
    if (!repository || !counts || !isTimestamp(candidate.lastCreated)) return undefined;
    projects.push({ repository, ...counts, lastCreated: candidate.lastCreated });
  }

  return { trackingSince: value.trackingSince, overall, projects };
}

export function displayDate(value) {
  if (!isTimestamp(value)) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(value));
}

function statsCounts(value, includeProjects) {
  const workspacesCreated = count(value.workspacesCreated);
  const warmNow = count(value.warmNow);
  const stoppedNow = count(value.stoppedNow);
  const projects = includeProjects ? count(value.projects) : undefined;
  if (
    workspacesCreated === undefined ||
    warmNow === undefined ||
    stoppedNow === undefined ||
    (includeProjects && projects === undefined)
  )
    return undefined;
  return {
    workspacesCreated,
    ...(includeProjects ? { projects } : {}),
    warmNow,
    stoppedNow,
  };
}

function repositoryName(value) {
  if (typeof value !== "string") return undefined;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value) ? value : undefined;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
