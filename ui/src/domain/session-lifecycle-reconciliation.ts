import type { SessionLifecycleAction, SessionMutationResult } from "../data/session-lifecycle";
import type { SessionLifecycle, SessionReadResult } from "../data/session-reader";

export interface LifecycleControlMessage {
  readonly action: SessionLifecycleAction;
  readonly kind: "error" | "reconciliation";
  readonly sessionId: string;
  readonly startedFrom: SessionLifecycle | null;
  readonly text: string;
}

const actionVerb = (action: SessionLifecycleAction): string =>
  action === "checkpoint"
    ? "save the checkpoint"
    : action === "sleep"
      ? "put the session to sleep"
      : action === "resume"
        ? "resume the session"
        : "vaporize the session";

export const hasReachedLifecycleTarget = (
  action: SessionLifecycleAction,
  startedFrom: SessionLifecycle | null,
  current: SessionLifecycle,
): boolean => {
  if (action === "sleep") return startedFrom === "warm" && current === "sleeping";
  if (action === "resume")
    return (startedFrom === "sleeping" || startedFrom === "failed") && current === "warm";
  if (action === "vaporize")
    return startedFrom !== null && startedFrom !== "gone" && current === "gone";
  return false;
};

export const isLifecycleMessageResolved = (
  message: LifecycleControlMessage | null,
  source: "actor" | "projection",
  freshness: "fresh" | "stale",
  lifecycle: SessionLifecycle | null,
): boolean =>
  message !== null &&
  source === "actor" &&
  freshness === "fresh" &&
  lifecycle !== null &&
  hasReachedLifecycleTarget(message.action, message.startedFrom, lifecycle);

const expectedLifecycleFor = (action: SessionLifecycleAction): SessionLifecycle =>
  action === "sleep" ? "sleeping" : action === "vaporize" ? "gone" : "warm";

const hasExpectedLifecycle = (
  result: SessionReadResult | undefined,
  action: SessionLifecycleAction,
): boolean =>
  result?.ok === true &&
  result.session.authority.kind === "stable" &&
  result.session.authority.lifecycle === expectedLifecycleFor(action);

const authoritativeReachedLifecycleTarget = (
  result: SessionReadResult | undefined,
  action: SessionLifecycleAction,
  startedFrom: SessionLifecycle | null,
): boolean =>
  result?.ok === true &&
  result.session.authority.kind === "stable" &&
  hasReachedLifecycleTarget(action, startedFrom, result.session.authority.lifecycle);

const mutationErrorMessage = (
  action: SessionLifecycleAction,
  result: Extract<SessionMutationResult, { readonly ok: false }>,
): string => {
  if (result.failure.kind === "network")
    return `Could not reach the session to ${actionVerb(action)}. Check your connection and try again.`;
  if (result.failure.kind === "malformed-response")
    return "The session action response could not be verified. Check the current state before trying again.";
  if (result.failure.status === 401 || result.failure.status === 403)
    return "You are not authorized to change this session. Sign in again and retry.";
  if (result.failure.status === 404)
    return "This session is no longer available. Refresh the session list.";
  return `Could not ${actionVerb(action)}. ${result.failure.hint ?? "Check the current state and try again."}`;
};

export const resolveLifecycleActionMessage = (
  action: SessionLifecycleAction,
  sessionId: string,
  startedFrom: SessionLifecycle | null,
  mutation: SessionMutationResult,
  authoritative: SessionReadResult | undefined,
  refreshed: boolean,
): LifecycleControlMessage | null => {
  if (authoritativeReachedLifecycleTarget(authoritative, action, startedFrom)) return null;
  if (
    mutation.ok &&
    !("pending" in mutation) &&
    refreshed &&
    hasExpectedLifecycle(authoritative, action)
  )
    return null;

  const message = (
    kind: LifecycleControlMessage["kind"],
    text: string,
  ): LifecycleControlMessage => ({ action, kind, sessionId, startedFrom, text });

  if (mutation.ok && (authoritative === undefined || !authoritative.ok))
    return message(
      "error",
      "The action completed, but the current session state could not be verified. Check again.",
    );
  if (!mutation.ok && mutation.failure.kind === "http" && mutation.failure.status === 409)
    return message(
      "reconciliation",
      authoritative?.ok
        ? refreshed
          ? "The session changed while this action was starting. The latest state is shown."
          : "The session changed while this action was starting. Refresh to see the latest state."
        : "The session changed while this action was starting. Refresh to see the latest state.",
    );
  if (!mutation.ok) return message("error", mutationErrorMessage(action, mutation));
  if ("pending" in mutation)
    return message(
      "reconciliation",
      refreshed
        ? "The session action is still running. The latest state is shown."
        : "The session action is still running. Refresh to see the latest state.",
    );
  if (!refreshed)
    return message(
      "error",
      "The action completed, but the session view could not refresh. Reload to confirm.",
    );
  return message(
    "reconciliation",
    "The session state changed while this action was completing. The latest state is shown.",
  );
};
