import { assert, describe, it } from "vitest";
import {
  markUiResponseDelivered,
  sendUiResponseForProjection,
} from "../public/terminal-ui-response.js";

const deferred = <A>() => {
  let resolve = (_value: A): void => undefined;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const projectionWithRequest = (requestId: string, epoch = "epoch-a") => ({
  epoch,
  pendingUi: new Map([[requestId, { id: requestId, method: "input" }]]),
  deliveredUiResponses: new Set<string>(),
});

describe("terminal UI responses", () => {
  it("settles an in-flight response against its original projection after a session switch", async () => {
    const requestId = "shared-request-id";
    const projectionA = projectionWithRequest(requestId);
    const projectionB = projectionWithRequest(requestId);
    const command = deferred<{ status: string }>();
    let currentSessionId = "session-a";
    let currentProjection = projectionA;
    const cardStates: string[] = [];
    const sent: Array<{ intent: unknown; label: string }> = [];

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
      markDelivered: (_sessionId, projection, targetRequestId) =>
        markUiResponseDelivered(projection, projection, targetRequestId),
      setCardPending: () => cardStates.push("sending"),
      setCardDelivered: () => cardStates.push("delivered"),
      setCardRetryable: () => cardStates.push("retryable"),
      reportError: () => cardStates.push("error"),
    });

    currentSessionId = "session-b";
    currentProjection = projectionB;
    command.resolve({ status: "delivered" });
    await response;

    assert.deepStrictEqual(sent, [
      {
        intent: { type: "extension_ui_response", id: requestId, value: "answer for A" },
        label: "Answer Pi question: answer for A",
      },
    ]);
    assert.deepStrictEqual([...projectionA.deliveredUiResponses], [requestId]);
    assert.deepStrictEqual([...projectionB.deliveredUiResponses], []);
    assert.deepStrictEqual(cardStates, ["sending"]);
  });

  it("does not apply an old response error to a replacement epoch", async () => {
    const requestId = "request-1";
    const original = projectionWithRequest(requestId);
    const replacement = projectionWithRequest(requestId, "epoch-b");
    let currentProjection = original;
    const cardStates: string[] = [];
    const command = deferred<{ status: string }>();

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
      setCardPending: () => cardStates.push("sending"),
      setCardDelivered: () => cardStates.push("delivered"),
      setCardRetryable: () => cardStates.push("retryable"),
      reportError: () => cardStates.push("error"),
    });

    currentProjection = replacement;
    command.resolve({ status: "rejected" });
    await response;

    assert.deepStrictEqual(cardStates, ["sending"]);
  });

  it("updates a replacement card after a same-epoch refresh during delivery", async () => {
    const requestId = "request-1";
    const original = projectionWithRequest(requestId);
    const refreshed = projectionWithRequest(requestId);
    const command = deferred<{ status: string }>();
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
        currentProjection.pendingUi.has(targetRequestId),
      hasCurrentDelivery: (_sessionId, targetRequestId) =>
        currentProjection.deliveredUiResponses.has(targetRequestId),
      markDelivered: (_sessionId, projection, targetRequestId) =>
        markUiResponseDelivered(projection, currentProjection, targetRequestId),
      setCardPending: () => cardStates.push("sending"),
      setCardDelivered: () => cardStates.push("delivered"),
      setCardRetryable: () => cardStates.push("retryable"),
      reportError: () => cardStates.push("error"),
    });

    currentProjection = refreshed;
    command.resolve({ status: "delivered" });
    await response;

    assert.deepStrictEqual([...refreshed.deliveredUiResponses], [requestId]);
    assert.deepStrictEqual(cardStates, ["sending", "delivered"]);
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
