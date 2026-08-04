export function createUiResponseTracker() {
  const sessions = new Map();
  const keyFor = (epoch, requestId) => JSON.stringify([epoch, requestId]);
  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { pending: new Map(), delivered: new Set() };
      sessions.set(sessionId, state);
    }
    return state;
  };
  const dropEmpty = (sessionId, state) => {
    if (state.pending.size === 0 && state.delivered.size === 0) sessions.delete(sessionId);
  };

  return {
    begin(sessionId, epoch, requestId) {
      const pending = stateFor(sessionId).pending;
      const key = keyFor(epoch, requestId);
      pending.set(key, (pending.get(key) ?? 0) + 1);
    },

    finish(sessionId, epoch, requestId) {
      const state = sessions.get(sessionId);
      if (!state) return;
      const key = keyFor(epoch, requestId);
      const count = state.pending.get(key) ?? 0;
      if (count > 1) state.pending.set(key, count - 1);
      else state.pending.delete(key);
      dropEmpty(sessionId, state);
    },

    markDelivered(sessionId, epoch, requestId) {
      stateFor(sessionId).delivered.add(keyFor(epoch, requestId));
    },

    sync(sessionId, epoch, requestIds) {
      const state = sessions.get(sessionId);
      if (!state) return;
      const current = new Set([...requestIds].map((requestId) => keyFor(epoch, requestId)));
      for (const key of state.delivered) if (!current.has(key)) state.delivered.delete(key);
      dropEmpty(sessionId, state);
    },

    isPending(sessionId, epoch, requestId) {
      return (sessions.get(sessionId)?.pending.get(keyFor(epoch, requestId)) ?? 0) > 0;
    },

    isDelivered(sessionId, epoch, requestId) {
      return sessions.get(sessionId)?.delivered.has(keyFor(epoch, requestId)) ?? false;
    },

    hasPending(sessionId) {
      return (sessions.get(sessionId)?.pending.size ?? 0) > 0;
    },
  };
}

export function uiResponseCardState(delivered, pending) {
  if (delivered) return { disabled: true, label: "Awaiting Pi continuation · outcome unconfirmed" };
  if (pending) return { disabled: true, label: "Sending…" };
  return { disabled: false, label: "Pi paused" };
}

export function markUiResponseDelivered(projection, latestProjection, requestId) {
  projection.deliveredUiResponses.add(requestId);
  if (
    latestProjection !== projection &&
    latestProjection?.epoch === projection.epoch &&
    latestProjection.pendingUi.has(requestId)
  )
    latestProjection.deliveredUiResponses.add(requestId);
}

export async function sendUiResponseForProjection({
  sessionId,
  projection,
  requestId,
  value,
  cancelled = false,
  sendCommand,
  hasCurrentRequest,
  hasCurrentDelivery,
  markDelivered,
  setPendingState,
  setCardPending,
  setCardDelivered,
  setCardRetryable,
  reportError,
}) {
  const request = projection.pendingUi.get(requestId);
  if (!request) return;
  setPendingState(sessionId, projection, requestId, true);
  try {
    setCardPending();
    const command = cancelled
      ? { type: "extension_ui_response", id: requestId, cancelled: true }
      : request.method === "confirm"
        ? { type: "extension_ui_response", id: requestId, confirmed: Boolean(value) }
        : { type: "extension_ui_response", id: requestId, value: String(value) };
    const receipt = await sendCommand(
      command,
      cancelled ? "Cancel Pi question" : `Answer Pi question: ${String(value)}`,
    );
    if (receipt.status !== "delivered")
      throw new Error("Pi did not confirm delivery of that response.");
    markDelivered(sessionId, projection, requestId);
    setPendingState(sessionId, projection, requestId, false);
    if (hasCurrentDelivery(sessionId, requestId)) setCardDelivered();
  } catch (error) {
    setPendingState(sessionId, projection, requestId, false);
    if (!hasCurrentRequest(sessionId, projection, requestId)) return;
    setCardRetryable();
    reportError(error instanceof Error ? error.message : "Pi did not accept that response.");
  }
}
