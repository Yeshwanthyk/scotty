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
  return summary.steps
    .map((step, position) => ({ step, position }))
    .sort((left, right) => {
      const leftOffset = left.step?.frame?.offsetMillis;
      const rightOffset = right.step?.frame?.offsetMillis;
      const leftHasOffset = Number.isFinite(leftOffset);
      const rightHasOffset = Number.isFinite(rightOffset);
      if (leftHasOffset && rightHasOffset && leftOffset !== rightOffset)
        return leftOffset - rightOffset;
      if (leftHasOffset !== rightHasOffset) return leftHasOffset ? -1 : 1;
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
