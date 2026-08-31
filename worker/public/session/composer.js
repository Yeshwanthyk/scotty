export function createSessionMemory() {
  const entries = new Map();
  const entry = (sessionId) => {
    let value = entries.get(sessionId);
    if (!value) {
      value = { draft: "", scrollTop: 0, delivery: undefined };
      entries.set(sessionId, value);
    }
    return value;
  };
  return {
    entry,
    restoreDraft(sessionId, text) {
      const value = entry(sessionId);
      value.draft = value.draft.trim() ? `${text}\n\n${value.draft}` : text;
      return value;
    },
  };
}

export function selectedDeliveryMode(root) {
  return root.querySelector('input[name="delivery-mode"]:checked')?.value === "steer"
    ? "steer"
    : "follow_up";
}

export function shouldSubmitComposerKey(event) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

const queueText = (item) =>
  typeof item === "string" ? item : typeof item?.text === "string" ? item.text : undefined;

const messageText = (message) => {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return undefined;
  return message.content
    .map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text : ""))
    .join("");
};

const boundedQueueMessage = (message, maximum = 52) => {
  const compact = String(message ?? "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return compact.length > maximum ? `${compact.slice(0, maximum).trimEnd()}…` : compact;
};

const activityForTool = (name) => {
  const normalized = String(name ?? "").toLowerCase();
  if (/hatch/u.test(normalized)) return "Starting Hatch";
  if (/browser|playwright|evidence/u.test(normalized)) return "Testing in browser";
  if (/apply_patch|edit|write|replace/u.test(normalized)) return "Editing files";
  if (/bash|shell|exec|command|terminal/u.test(normalized)) return "Running command";
  if (/subagent|spawn_agent|wait_agent|agent/u.test(normalized)) return "Coordinating agents";
  if (/read|search|find|grep|glob|list/u.test(normalized)) return "Reading project";
  return "Using a tool";
};

export function currentActivity(projection) {
  if (!projection?.active) return undefined;
  if ((projection.pendingUi?.size ?? 0) > 0) return "Waiting for your input";
  const running = projection.tools?.values
    ? [...projection.tools.values()].filter((tool) => tool?.status === "running")
    : [];
  return running.length > 0 ? activityForTool(running.at(-1)?.name) : "Thinking";
}

export function reconcileDelivery(delivery, projection, event) {
  if (!delivery || !projection) return delivery;
  const queue = delivery.kind === "steer" ? projection.queue?.steer : projection.queue?.followUp;
  const queued = Array.isArray(queue) && queue.some((item) => queueText(item) === delivery.message);
  if (queued && ["submitting", "accepted"].includes(delivery.status))
    return { ...delivery, status: "queued" };
  if (delivery.status === "queued" && !queued) return { ...delivery, status: "delivered" };
  const message = event?.message;
  const deliveredPrompt =
    delivery.kind === "prompt" &&
    ["submitting", "accepted"].includes(delivery.status) &&
    (message?.role === "user" && messageText(message) === delivery.message
      ? true
      : projection.messages?.some(
          (candidate) => candidate?.role === "user" && messageText(candidate) === delivery.message,
        ));
  if (deliveredPrompt) return { ...delivery, status: "delivered" };
  return delivery;
}

const defaultHint = (projection) => {
  if (!projection) return "Loading session state…";
  const activity = currentActivity(projection);
  return activity ? `Pi is working · ${activity}` : "Pi is ready";
};

const sendLabel = (active, deliveryMode) => {
  if (!active) return "Send";
  return deliveryMode === "steer" ? "Steer now" : "Send follow-up";
};

const queuedDeliveryHint = (delivery, activity) => {
  const message = boundedQueueMessage(delivery?.message);
  return delivery?.kind === "steer"
    ? `Steer queued · delivers after ${activity ?? "current action"} · “${message}”`
    : `Follow-up queued · sends after Pi finishes · “${message}”`;
};

export function composerPresentation({ projection, lane, draft, delivery, deliveryMode }) {
  const active = Boolean(projection?.active);
  const paused = lane.paused;
  const sending = lane.items.some((item) => item.state === "sending");
  const status = paused === "ambiguous" ? "ambiguous" : sending ? "submitting" : delivery?.status;
  const activity = currentActivity(projection);
  const messages = {
    submitting: "Submitting…",
    accepted: "Accepted by Pi",
    queued: queuedDeliveryHint(delivery, activity),
    delivered: "Delivered to Pi",
    stale:
      delivery?.detail === "refreshed"
        ? "Session refreshed · review and send again"
        : "Session changed · refreshing…",
    ambiguous: "Delivery unknown · check the conversation before recovering",
    failed: delivery?.detail ? `Failed · ${delivery.detail}` : "Delivery failed · try again",
  };
  return {
    active,
    recovery: paused === "ambiguous",
    sendDisabled: Boolean(paused || !projection || !draft.trim() || sending),
    stopDisabled: Boolean(paused || sending),
    sendLabel: sendLabel(active, deliveryMode),
    status: status ?? (projection ? (active ? "working" : "ready") : "loading"),
    hint: messages[status] ?? defaultHint(projection),
  };
}

export function renderComposerPresentation(elements, presentation) {
  elements.recovery.hidden = !presentation.recovery;
  elements.deliveryControls.hidden = !presentation.active;
  elements.stopButton.hidden = !presentation.active;
  elements.stopButton.disabled = presentation.stopDisabled;
  elements.sendButton.disabled = presentation.sendDisabled;
  elements.sendButton.textContent = presentation.sendLabel;
  elements.hint.dataset.state = presentation.status;
  if (elements.hint.textContent !== presentation.hint)
    elements.hint.textContent = presentation.hint;
}
