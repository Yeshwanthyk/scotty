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
  isCurrentProjection,
  markDelivered,
  setCardPending,
  setCardDelivered,
  setCardRetryable,
  reportError,
}) {
  const request = projection.pendingUi.get(requestId);
  if (!request) return;
  setCardPending();
  try {
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
    if (isCurrentProjection(sessionId, projection)) setCardDelivered();
  } catch (error) {
    if (!isCurrentProjection(sessionId, projection)) return;
    setCardRetryable();
    reportError(error instanceof Error ? error.message : "Pi did not accept that response.");
  }
}
