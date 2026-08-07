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

export function orderedReplayFrames(summary) {
  if (!summary || !Array.isArray(summary.steps)) return [];
  return summary.steps
    .flatMap((step) => {
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
    })
    .sort(
      (left, right) => left.offsetMillis - right.offsetMillis || left.stepIndex - right.stepIndex,
    );
}

export function replayDelayMillis(frames, index) {
  const current = frames[index];
  const next = frames[index + 1];
  if (!current || !next) return 1_000;
  return Math.min(3_000, Math.max(250, next.offsetMillis - current.offsetMillis));
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
