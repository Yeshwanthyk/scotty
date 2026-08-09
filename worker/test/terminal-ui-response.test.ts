import { assert, describe, it } from "vitest";
import {
  createUiResponseTracker,
  markUiResponseDelivered,
  sendUiResponseForProjection,
  uiResponseCardState,
} from "../public/terminal-ui-response.js";
import type { PiConsoleCommandReceiptV1, PiConsoleRemoteIntentV1 } from "../../protocol/pi-console";
import type { UiResponseProjection } from "../public/terminal-ui-response.js";

const deferred = <A>() => {
  let resolve = (_value: A): void => undefined;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const projectionWithRequest = (requestId: string, epoch = "epoch-a"): UiResponseProjection => ({
  epoch,
  pendingUi: new Map([[requestId, { id: requestId, method: "input", title: "Question" }]]),
  deliveredUiResponses: new Set<string>(),
});

const commandReceipt = (
  status: PiConsoleCommandReceiptV1["status"],
): PiConsoleCommandReceiptV1 => ({
  version: 1,
  epoch: "epoch-a",
  commandId: "123e4567-e89b-42d3-a456-426614174000",
  commandDigest: "0".repeat(64),
  status,
  response: null,
});

const pendingState =
  (tracker: ReturnType<typeof createUiResponseTracker>) =>
  (sessionId: string, projection: { epoch?: string }, requestId: string, pending: boolean) => {
    if (pending) tracker.begin(sessionId, projection.epoch, requestId);
    else tracker.finish(sessionId, projection.epoch, requestId);
  };

describe("terminal UI responses", () => {
  it("settles an in-flight response against its original projection after a session switch", async () => {
    const requestId = "shared-request-id";
    const projectionA = projectionWithRequest(requestId);
    const projectionB = projectionWithRequest(requestId);
    const command = deferred<PiConsoleCommandReceiptV1>();
    const tracker = createUiResponseTracker();
    let currentSessionId = "session-a";
    let currentProjection = projectionA;
    const cardStates: string[] = [];
    const sent: Array<{ intent: PiConsoleRemoteIntentV1; label: string }> = [];

    const response = sendUiResponseForProjection({
      sessionId: "session-a",
      projection: projectionA,
      requestId,
      value: "answer for A",
      sendCommand: (intent, label) => {
        sent.push({ intent, label });
        return command.promise;
      },
      hasCurrentRequest: (sessionId, projection, targetRequestId) =>
        sessionId === currentSessionId &&
        projection.epoch === currentProjection.epoch &&
        currentProjection.pendingUi.has(targetRequestId),
      hasCurrentDelivery: (sessionId, targetRequestId) =>
        sessionId === currentSessionId &&
        currentProjection.deliveredUiResponses.has(targetRequestId),
      markDelivered: (sessionId, projection, targetRequestId) => {
        tracker.markDelivered(sessionId, projection.epoch, targetRequestId);
        markUiResponseDelivered(projection, projection, targetRequestId);
      },
      setPendingState: pendingState(tracker),
      setCardPending: () => cardStates.push("sending"),
      setCardDelivered: () => cardStates.push("delivered"),
      setCardRetryable: () => cardStates.push("retryable"),
      reportError: () => cardStates.push("error"),
    });

    currentSessionId = "session-b";
    currentProjection = projectionB;
    command.resolve(commandReceipt("delivered"));
    await response;

    assert.deepStrictEqual(sent, [
      {
        intent: { type: "extension_ui_response", id: requestId, value: "answer for A" },
        label: "Answer Pi question: answer for A",
      },
    ]);
    assert.deepStrictEqual([...projectionA.deliveredUiResponses], [requestId]);
    assert.deepStrictEqual([...projectionB.deliveredUiResponses], []);
    assert.isFalse(tracker.hasPending("session-a"));
    assert.deepStrictEqual(cardStates, ["sending"]);
  });

  it("does not apply an old response error to a replacement epoch", async () => {
    const requestId = "request-1";
    const original = projectionWithRequest(requestId);
    const replacement = projectionWithRequest(requestId, "epoch-b");
    const tracker = createUiResponseTracker();
    let currentProjection = original;
    const cardStates: string[] = [];
    const command = deferred<PiConsoleCommandReceiptV1>();

    const response = sendUiResponseForProjection({
      sessionId: "session-a",
      projection: original,
      requestId,
      value: "answer",
      sendCommand: () => command.promise,
      hasCurrentRequest: (_sessionId, projection, targetRequestId) =>
        projection.epoch === currentProjection.epoch &&
        currentProjection.pendingUi.has(targetRequestId),
      hasCurrentDelivery: () => false,
      markDelivered: () => undefined,
      setPendingState: pendingState(tracker),
      setCardPending: () => cardStates.push("sending"),
      setCardDelivered: () => cardStates.push("delivered"),
      setCardRetryable: () => cardStates.push("retryable"),
      reportError: () => cardStates.push("error"),
    });

    currentProjection = replacement;
    command.resolve(commandReceipt("rejected"));
    await response;

    assert.isFalse(tracker.hasPending("session-a"));
    assert.deepStrictEqual(cardStates, ["sending"]);
  });

  it("does not re-enable a card after another response already delivered", async () => {
    const requestId = "request-1";
    const projection = projectionWithRequest(requestId);
    const tracker = createUiResponseTracker();
    const cardStates: string[] = [];
    projection.deliveredUiResponses.add(requestId);

    await sendUiResponseForProjection({
      sessionId: "session-a",
      projection,
      requestId,
      value: "duplicate",
      sendCommand: async () => commandReceipt("rejected"),
      hasCurrentRequest: (_sessionId, _projection, targetRequestId) =>
        projection.pendingUi.has(targetRequestId) &&
        !projection.deliveredUiResponses.has(targetRequestId),
      hasCurrentDelivery: (_sessionId, targetRequestId) =>
        projection.deliveredUiResponses.has(targetRequestId),
      markDelivered: () => undefined,
      setPendingState: pendingState(tracker),
      setCardPending: () => cardStates.push("sending"),
      setCardDelivered: () => cardStates.push("delivered"),
      setCardRetryable: () => cardStates.push("retryable"),
      reportError: () => cardStates.push("error"),
    });

    assert.isFalse(tracker.hasPending("session-a"));
    assert.deepStrictEqual(cardStates, ["sending"]);
  });

  it("keeps a replacement card pending through a same-epoch refresh", async () => {
    const requestId = "request-1";
    const original = projectionWithRequest(requestId);
    const refreshed = projectionWithRequest(requestId);
    const command = deferred<PiConsoleCommandReceiptV1>();
    const tracker = createUiResponseTracker();
    let currentProjection = original;
    const cardStates: string[] = [];

    const response = sendUiResponseForProjection({
      sessionId: "session-a",
      projection: original,
      requestId,
      value: "answer",
      sendCommand: () => command.promise,
      hasCurrentRequest: (sessionId, projection, targetRequestId) =>
        sessionId === "session-a" &&
        projection.epoch === currentProjection.epoch &&
        currentProjection.pendingUi.has(targetRequestId) &&
        !currentProjection.deliveredUiResponses.has(targetRequestId),
      hasCurrentDelivery: (_sessionId, targetRequestId) =>
        currentProjection.deliveredUiResponses.has(targetRequestId),
      markDelivered: (sessionId, projection, targetRequestId) => {
        tracker.markDelivered(sessionId, projection.epoch, targetRequestId);
        markUiResponseDelivered(projection, currentProjection, targetRequestId);
      },
      setPendingState: pendingState(tracker),
      setCardPending: () => cardStates.push("sending"),
      setCardDelivered: () => cardStates.push("delivered"),
      setCardRetryable: () => cardStates.push("retryable"),
      reportError: () => cardStates.push("error"),
    });

    currentProjection = refreshed;
    const tracked = tracker.isPending("session-a", refreshed.epoch, requestId);
    assert.isTrue(tracked);
    assert.deepStrictEqual(uiResponseCardState(false, tracked), {
      disabled: true,
      label: "Sending…",
    });
    command.resolve(commandReceipt("delivered"));
    await response;

    assert.deepStrictEqual([...refreshed.deliveredUiResponses], [requestId]);
    assert.isFalse(tracker.hasPending("session-a"));
    assert.isTrue(tracker.isDelivered("session-a", refreshed.epoch, requestId));
    assert.deepStrictEqual(cardStates, ["sending", "delivered"]);
  });

  it("keeps delivered state across cache replacement until the server removes the request", () => {
    const requestId = "request-1";
    const tracker = createUiResponseTracker();
    tracker.markDelivered("session-a", "epoch-a", requestId);

    tracker.sync("session-a", "epoch-a", [requestId]);
    assert.isTrue(tracker.isDelivered("session-a", "epoch-a", requestId));
    assert.deepStrictEqual(
      uiResponseCardState(tracker.isDelivered("session-a", "epoch-a", requestId), false),
      {
        disabled: true,
        label: "Awaiting Pi continuation · outcome unconfirmed",
      },
    );

    tracker.sync("session-a", "epoch-a", []);
    assert.isFalse(tracker.isDelivered("session-a", "epoch-a", requestId));
  });

  it("carries delivery state into a refreshed projection from the same epoch", () => {
    const requestId = "request-1";
    const original = projectionWithRequest(requestId);
    const refreshed = projectionWithRequest(requestId);
    const nextEpoch = projectionWithRequest(requestId, "epoch-b");

    markUiResponseDelivered(original, refreshed, requestId);
    markUiResponseDelivered(original, nextEpoch, requestId);

    assert.deepStrictEqual([...original.deliveredUiResponses], [requestId]);
    assert.deepStrictEqual([...refreshed.deliveredUiResponses], [requestId]);
    assert.deepStrictEqual([...nextEpoch.deliveredUiResponses], []);
  });
});
