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

export function reconcileDelivery(delivery, projection, event) {
  if (!delivery || !projection) return delivery;
  const queue = delivery.kind === "steer" ? projection.queue?.steer : projection.queue?.followUp;
  const queued = Array.isArray(queue) && queue.some((item) => queueText(item) === delivery.message);
  if (queued && ["submitting", "accepted"].includes(delivery.status))
    return { ...delivery, status: "queued" };
  if (delivery.status === "queued" && !queued) return { ...delivery, status: "delivered" };
  const message = event?.message;
  if (
    delivery.kind === "prompt" &&
    ["submitting", "accepted"].includes(delivery.status) &&
    message?.role === "user" &&
    message.content === delivery.message
  )
    return { ...delivery, status: "delivered" };
  return delivery;
}

const defaultHint = (projection) => {
  if (!projection) return "Loading session state…";
  return projection.active ? "Pi is working · choose when this message arrives" : "Pi is ready";
};

const sendLabel = (active, deliveryMode) => {
  if (!active) return "Send";
  return deliveryMode === "steer" ? "Steer now" : "Send follow-up";
};

export function composerPresentation({ projection, lane, draft, delivery, deliveryMode }) {
  const active = Boolean(projection?.active);
  const paused = lane.paused;
  const sending = lane.items.some((item) => item.state === "sending");
  const status = paused === "ambiguous" ? "ambiguous" : sending ? "submitting" : delivery?.status;
  const messages = {
    submitting: "Submitting…",
    accepted: "Accepted by Pi",
    queued:
      delivery?.kind === "steer" ? "Queued · steers Pi next" : "Queued · sends after Pi finishes",
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
