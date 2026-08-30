export const TERMINAL_EVIDENCE_STATUSES = new Set([
  "succeeded",
  "failed",
  "interrupted",
  "unsupported",
]);

export function isTerminalEvidenceStatus(status) {
  return TERMINAL_EVIDENCE_STATUSES.has(status);
}

export function shouldPollEvidence(payload, detail) {
  if (detail) return Boolean(payload && !isTerminalEvidenceStatus(payload.status));
  return Array.isArray(payload)
    ? payload.some((job) => job && !isTerminalEvidenceStatus(job.status))
    : false;
}

export function orderedEvidenceSteps(summary) {
  if (!summary || !Array.isArray(summary.steps)) return [];
  const positioned = summary.steps.map((step, position) => ({ step, position }));
  const allHaveOffsets = positioned.every(({ step }) => Number.isFinite(step?.frame?.offsetMillis));
  return positioned
    .sort((left, right) => {
      const leftOffset = left.step?.frame?.offsetMillis;
      const rightOffset = right.step?.frame?.offsetMillis;
      if (allHaveOffsets && leftOffset !== rightOffset) return leftOffset - rightOffset;
      const leftIndex = Number.isInteger(left.step?.index) ? left.step.index : left.position;
      const rightIndex = Number.isInteger(right.step?.index) ? right.step.index : right.position;
      return leftIndex - rightIndex || left.position - right.position;
    })
    .map(({ step }) => step);
}

export function orderedEvidenceFrames(summary) {
  return orderedEvidenceSteps(summary).flatMap((step) => {
    const frame = step?.frame;
    if (!frame || typeof frame.frameId !== "string") return [];
    return [
      {
        ...frame,
        stepIndex: Number.isInteger(step.index) ? step.index : 0,
        stepName: typeof step.name === "string" ? step.name : "Evidence checkpoint",
        stepStatus: step.status === "failed" ? "failed" : "passed",
      },
    ];
  });
}

export function evidenceStatusLabel(status) {
  return (
    {
      accepted: "Accepted",
      exposing: "Preparing preview",
      running: "Running",
      finalizing: "Finalizing",
      succeeded: "Passed",
      failed: "Failed",
      interrupted: "Interrupted",
      unsupported: "Unsupported",
    }[status] || "Unknown"
  );
}

export function evidenceFailurePresentation(failure) {
  if (!failure || typeof failure !== "object") return undefined;
  if (failure.code === "port_conflict")
    return {
      title: "Evidence target conflicts with Hatch",
      detail: "The requested app port is owned by Hatch or is still exposed.",
      hint: "Start a separate temporary app server on a different port, then rerun the same flow. Leave Hatch running.",
    };
  if (failure.code === "assertion_mismatch")
    return {
      title: "Evidence assertion failed",
      detail: `A required assertion failed at step ${(failure.step ?? 0) + 1}.`,
    };
  if (failure.code === "artifact_invalid")
    return {
      title: "Evidence capture failed",
      detail: "Evidence did not produce a valid screenshot or recording.",
      hint: "Check that the separate temporary app server is ready, then rerun the same flow.",
    };
  return {
    title: "Evidence run failed",
    detail: `Evidence stopped with ${String(failure.code).replaceAll("_", " ")}.`,
  };
}
