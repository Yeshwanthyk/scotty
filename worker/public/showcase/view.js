const SHOWCASE_FAILURES = {
  expired: {
    title: "Showcase expired or removed",
    detail:
      "This Showcase is no longer available. Its retained evidence may have expired or been removed.",
    retry: false,
  },
  unmatched: {
    title: "Showcase does not match",
    detail:
      "These evidence runs no longer form a matched Showcase. Open Evidence and choose a matching pair.",
    retry: false,
  },
  temporary: {
    title: "Showcase temporarily unavailable",
    detail: "Scotty could not reach the retained browser proof. Try again in a moment.",
    retry: true,
  },
  malformed: {
    title: "Showcase data is malformed",
    detail: "Scotty received an invalid Showcase payload. Try again or return to Evidence.",
    retry: true,
  },
};

export function formatShowcaseDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Duration unavailable";
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainder = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
    : `${minutes}:${remainder}`;
}

export function showcaseLoadFailure({ status, code } = {}) {
  if (status === 404 || code === "not_found") return { ...SHOWCASE_FAILURES.expired };
  if (status === 409 || code === "wrong_state") return { ...SHOWCASE_FAILURES.unmatched };
  if (status === undefined || status === 0 || status >= 500 || code === "upstream")
    return { ...SHOWCASE_FAILURES.temporary };
  return { ...SHOWCASE_FAILURES.malformed };
}

export function showcaseVideoState(kind) {
  if (kind === "error")
    return {
      label: "Recording unavailable",
      detail: "The browser recording could not be played right now.",
    };
  return { label: "Recording ready", detail: "The browser recording is ready to play." };
}
