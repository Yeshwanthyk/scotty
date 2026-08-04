import { commandIntentDigest, PI_CONSOLE_PROTOCOL_VERSION } from "./terminal-console-protocol.js";

const receiptStatuses = new Set(["accepted", "delivered", "rejected"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMatchingReceipt(body, envelope, expectedDigest) {
  return (
    isObject(body) &&
    body.version === PI_CONSOLE_PROTOCOL_VERSION &&
    body.epoch === envelope.epoch &&
    body.commandId === envelope.commandId &&
    typeof body.commandDigest === "string" &&
    body.commandDigest === expectedDigest &&
    receiptStatuses.has(body.status) &&
    Object.hasOwn(body, "response")
  );
}

function explicitError(body) {
  return (
    isObject(body) &&
    body.version === PI_CONSOLE_PROTOCOL_VERSION &&
    body.status === "error" &&
    typeof body.code === "string" &&
    body.retryable === false
  );
}

function staleResult(result) {
  const body = result.body;
  if (
    isObject(body) &&
    body.version === PI_CONSOLE_PROTOCOL_VERSION &&
    body.status === "stale" &&
    Number.isSafeInteger(body.expectedSessionRevision) &&
    Number.isSafeInteger(body.sessionRevision) &&
    body.retryable === false
  )
    return body;
  if (explicitError(body) && body.code === "scotty_epoch_changed") return body;
  return undefined;
}

function commandErrorMessage(result) {
  const body = result.body;
  return (
    body?.message ??
    body?.error?.message ??
    (typeof body?.error === "string" ? body.error : undefined) ??
    (typeof body?.code === "string" ? body.code : undefined) ??
    `Command failed (${result.status})`
  );
}

function classifyResult(result, envelope, expectedDigest) {
  const stale = staleResult(result);
  if (stale) return { status: "stale", response: stale };

  if (isMatchingReceipt(result.body, envelope, expectedDigest)) {
    if (result.body.status === "rejected")
      return {
        status: "rejected",
        receipt: result.body,
        message: "Pi rejected the command",
      };
    if (result.ok) return { status: "accepted", receipt: result.body };
  }

  if (explicitError(result.body))
    return {
      status: "rejected",
      response: result.body,
      message: commandErrorMessage(result),
    };

  return {
    status: "ambiguous",
    response: result.body,
    message: result.readable
      ? "Scotty returned an unrecognized command outcome"
      : "Scotty returned an unreadable command outcome",
  };
}

export function createCommandLane({ send, randomUUID, onChange = () => {} }) {
  const items = [];
  const drainingSessions = new Set();
  const pausedSessions = new Map();

  const publish = () => onChange(items.map(({ resolve: _resolve, ...item }) => ({ ...item })));

  const pause = (sessionId, reason) => {
    pausedSessions.set(sessionId, reason);
    for (const item of items)
      if (item.sessionId === sessionId && item.state === "queued") item.state = "paused";
  };

  const drain = async (sessionId) => {
    if (drainingSessions.has(sessionId) || pausedSessions.has(sessionId)) return;
    const item = items.find(
      (candidate) => candidate.sessionId === sessionId && candidate.state === "queued",
    );
    if (!item) return;
    drainingSessions.add(sessionId);
    item.state = "sending";
    publish();

    let outcome;
    try {
      const expectedDigest = await commandIntentDigest(item.envelope.intent);
      outcome = classifyResult(
        await send(item.sessionId, item.envelope),
        item.envelope,
        expectedDigest,
      );
    } catch (error) {
      outcome = {
        status: "ambiguous",
        message:
          error instanceof Error ? error.message : "The command outcome could not be confirmed",
      };
    }

    if (outcome.status === "accepted") {
      items.splice(items.indexOf(item), 1);
    } else {
      item.state = outcome.status;
      item.outcome = outcome;
      if (outcome.status === "stale" || outcome.status === "ambiguous")
        pause(sessionId, outcome.status);
    }
    drainingSessions.delete(sessionId);
    item.resolve(outcome);
    publish();
    if (!pausedSessions.has(sessionId)) void drain(sessionId);
  };

  return {
    enqueue({ sessionId, epoch, expectedSessionRevision, intent, label }) {
      const paused = pausedSessions.get(sessionId);
      if (paused)
        throw new Error(`Command lane for this session is paused after a ${paused} outcome`);
      const envelope = {
        version: PI_CONSOLE_PROTOCOL_VERSION,
        epoch,
        commandId: randomUUID(),
        expectedSessionRevision,
        intent,
      };
      let resolve;
      const outcome = new Promise((complete) => {
        resolve = complete;
      });
      const item = {
        sessionId,
        envelope,
        label,
        state: paused ? "paused" : "queued",
        resolve,
      };
      items.push(item);
      publish();
      void drain(sessionId);
      return { commandId: envelope.commandId, outcome };
    },

    discard(sessionId) {
      const reason = pausedSessions.get(sessionId);
      if (!reason) return { discardedCount: 0 };
      let discardedCount = 0;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item.sessionId !== sessionId || !["paused", "stale", "ambiguous"].includes(item.state))
          continue;
        if (item.state === "paused") {
          item.resolve({
            status: "discarded",
            accepted: false,
            message: "Command discarded without being sent",
          });
          discardedCount += 1;
        }
        items.splice(index, 1);
      }
      pausedSessions.delete(sessionId);
      publish();
      return { discardedCount };
    },

    state(sessionId) {
      return {
        paused: pausedSessions.get(sessionId),
        items: items
          .filter((item) => item.sessionId === sessionId)
          .map(({ resolve: _resolve, ...item }) => ({ ...item })),
      };
    },
  };
}

export async function classifyCommandResult(result, envelope) {
  return classifyResult(result, envelope, await commandIntentDigest(envelope.intent));
}
