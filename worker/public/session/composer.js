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

const queueText = (item) => {
  if (typeof item === "string") return item;
  if (typeof item?.text === "string") return item.text;
  if (typeof item?.message === "string") return item.message;
  if (typeof item?.prompt === "string") return item.prompt;
  return undefined;
};

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

export function queuePresentation(projection, maximum = 3) {
  const limit = Number.isSafeInteger(maximum) ? Math.max(0, maximum) : 3;
  const queue = projection?.queue;
  const items = [
    ...(Array.isArray(queue?.steer)
      ? queue.steer.map((item) => ({ mode: "steer", label: "Steer", text: queueText(item) }))
      : []),
    ...(Array.isArray(queue?.followUp)
      ? queue.followUp.map((item) => ({
          mode: "follow_up",
          label: "Queued",
          text: queueText(item),
        }))
      : []),
  ].filter((item) => item.text);
  return {
    items: items.slice(0, limit).map((item) => ({
      ...item,
      text: boundedQueueMessage(item.text, 88),
    })),
    overflow: Math.max(0, items.length - limit),
  };
}

export function renderComposerQueue(root, presentation) {
  root.replaceChildren();
  root.hidden = presentation.items.length === 0;
  presentation.items.forEach((item, index) => {
    const row = root.ownerDocument.createElement("li");
    row.className = `composer-queue-item queue-${item.mode}`;
    const order = root.ownerDocument.createElement("span");
    order.className = "composer-queue-order";
    order.textContent = String(index + 1);
    const text = root.ownerDocument.createElement("span");
    text.className = "composer-queue-text";
    text.textContent = item.text;
    const label = root.ownerDocument.createElement("small");
    label.textContent = item.label;
    row.append(order, text, label);
    root.append(row);
  });
  if (presentation.overflow > 0) {
    const more = root.ownerDocument.createElement("li");
    more.className = "composer-queue-more";
    more.textContent = `+${presentation.overflow} more`;
    root.append(more);
  }
}

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

export function reconcileAcceptedDelivery(delivery, accepted, projection) {
  const sameDelivery = delivery?.kind === accepted.kind && delivery?.message === accepted.message;
  if (sameDelivery && ["queued", "delivered"].includes(delivery.status))
    return reconcileDelivery(delivery, projection);
  return reconcileDelivery(accepted, projection);
}

const defaultHint = (projection) => {
  if (!projection) return "Loading session state…";
  const activity = currentActivity(projection);
  return activity ? `Pi is working · ${activity}` : "Pi is ready";
};

const sendLabel = (active, deliveryMode, submitting) => {
  if (submitting) return "Submitting…";
  if (!active) return "Send";
  return deliveryMode === "steer" ? "Steer now" : "Queue follow-up";
};

const queuedDeliveryHint = (delivery, activity) => {
  return delivery?.kind === "steer"
    ? `Steer queued · delivers after ${activity ?? "current action"}`
    : "Follow-up queued · sends after Pi finishes";
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
    deliveryDisabled: Boolean(paused || sending),
    sendDisabled: Boolean(paused || !projection || !draft.trim() || sending),
    stopDisabled: Boolean(paused || sending),
    sendLabel: sendLabel(active, deliveryMode, sending),
    status: status ?? (projection ? (active ? "working" : "ready") : "loading"),
    hint: messages[status] ?? defaultHint(projection),
  };
}

export function renderComposerPresentation(elements, presentation) {
  elements.recovery.hidden = !presentation.recovery;
  elements.deliveryControls.hidden = !presentation.active;
  elements.deliveryControls.disabled = presentation.deliveryDisabled;
  elements.stopButton.hidden = !presentation.active;
  elements.stopButton.disabled = presentation.stopDisabled;
  elements.sendButton.disabled = presentation.sendDisabled;
  elements.sendButton.setAttribute?.("aria-label", presentation.sendLabel);
  elements.sendButton.setAttribute?.("title", presentation.sendLabel);
  const sendLabel = elements.sendButton.querySelector?.(".button-label");
  if (sendLabel) sendLabel.textContent = presentation.sendLabel;
  else elements.sendButton.textContent = presentation.sendLabel;
  elements.hint.dataset.state = presentation.status;
  if (elements.hint.textContent !== presentation.hint)
    elements.hint.textContent = presentation.hint;
}
