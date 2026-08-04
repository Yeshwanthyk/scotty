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
      isCurrentProjection: (sessionId, projection) =>
        sessionId === currentSessionId && projection === currentProjection,
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
