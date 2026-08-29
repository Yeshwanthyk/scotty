export const PI_CONSOLE_PROTOCOL_VERSION = 1;

export const canonicalJson = (value) => {
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Canonical JSON value is not serializable");
  return encoded;
};

export const commandIntentDigest = async (intent) => {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(intent)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const RECEIPT_STATUSES = new Set(["accepted", "delivered", "rejected"]);
const EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "extension_ui_request",
  "extension_ui_response",
  "extension_ui_cancelled",
  "extension_ui_closed",
  "state_update",
  "scotty_replay_gap",
  "scotty_epoch_changed",
];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function consoleUrl(sessionId, operation) {
  return `/s/${encodeURIComponent(sessionId)}/console/v1/${operation}`;
}

async function responseBody(response) {
  try {
    return { readable: true, value: await response.json() };
  } catch {
    return { readable: false, value: undefined };
  }
}

export function createConsoleTransport({ fetch, eventSource, origin }) {
  return {
    async snapshot(sessionId, signal) {
      const response = await fetch(consoleUrl(sessionId, "snapshot"), {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        cache: "no-store",
        signal,
      });
      const body = await responseBody(response);
      if (!response.ok)
        throw new Error(
          body.value?.error?.message ?? `Could not load Pi session (${response.status})`,
        );
      if (!body.readable) throw new Error("Scotty returned an unreadable Pi session snapshot");
      return body.value;
    },

    events(sessionId, { epoch, sequence }) {
      const url = new URL(consoleUrl(sessionId, "events"), origin);
      if (epoch) url.searchParams.set("epoch", epoch);
      if (Number.isSafeInteger(sequence)) url.searchParams.set("since", String(sequence));
      return eventSource(url);
    },

    async command(sessionId, envelope) {
      const response = await fetch(consoleUrl(sessionId, "command"), {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
      const body = await responseBody(response);
      return {
        ok: response.ok,
        status: response.status,
        readable: body.readable,
        body: body.value,
      };
    },
  };
}

function matchingReceipt(body, envelope, digest) {
  return (
    isObject(body) &&
    body.version === PI_CONSOLE_PROTOCOL_VERSION &&
    body.epoch === envelope.epoch &&
    body.commandId === envelope.commandId &&
    body.commandDigest === digest &&
    RECEIPT_STATUSES.has(body.status) &&
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

export async function classifyCommandResult(result, envelope) {
  const body = result.body;
  if (
    isObject(body) &&
    body.version === PI_CONSOLE_PROTOCOL_VERSION &&
    body.status === "stale" &&
    Number.isSafeInteger(body.expectedSessionRevision) &&
    Number.isSafeInteger(body.sessionRevision) &&
    body.retryable === false
  )
    return { status: "stale", response: body };
  if (explicitError(body) && body.code === "scotty_epoch_changed")
    return { status: "stale", response: body };

  const digest = await commandIntentDigest(envelope.intent);
  if (matchingReceipt(body, envelope, digest)) {
    if (body.status === "rejected")
      return { status: "rejected", receipt: body, message: "Pi rejected the command" };
    if (result.ok) return { status: "accepted", receipt: body };
  }
  if (explicitError(body))
    return {
      status: "rejected",
      response: body,
      message: body.message ?? body.error?.message ?? body.code,
    };
  return {
    status: "ambiguous",
    response: body,
    message: result.readable
      ? "Scotty returned an unrecognized command outcome"
      : "Scotty returned an unreadable command outcome",
  };
}

export function createCommandLane({ send, randomUUID, onChange = () => {} }) {
  const items = [];
  const pausedSessions = new Map();
  const drainingSessions = new Set();
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
      outcome = await classifyCommandResult(await send(sessionId, item.envelope), item.envelope);
    } catch (error) {
      outcome = {
        status: "ambiguous",
        message:
          error instanceof Error ? error.message : "The command outcome could not be confirmed",
      };
    }
    if (outcome.status === "accepted") items.splice(items.indexOf(item), 1);
    else {
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
      items.push({ sessionId, envelope, label, state: "queued", resolve });
      publish();
      void drain(sessionId);
      return { commandId: envelope.commandId, outcome };
    },

    discard(sessionId) {
      if (!pausedSessions.has(sessionId)) return { discardedCount: 0 };
      let discardedCount = 0;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item.sessionId !== sessionId || !["paused", "stale", "ambiguous"].includes(item.state))
          continue;
        if (item.state === "paused") {
          item.resolve({
            status: "discarded",
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

export function createPiConnection({ transport, randomUUID, onEvent, onState, onLaneChange }) {
  let activeSessionId;
  let snapshotController;
  let source;
  const lane = createCommandLane({
    send: transport.command,
    randomUUID,
    onChange: onLaneChange,
  });

  const closeTransport = () => {
    snapshotController?.abort();
    snapshotController = undefined;
    source?.close();
    source = undefined;
  };

  const connectEvents = (sessionId, snapshot) => {
    source?.close();
    onState("connecting");
    const next = transport.events(sessionId, {
      epoch: snapshot.epoch,
      sequence: snapshot.sequence,
    });
    source = next;
    next.addEventListener("open", () => {
      if (source === next) onState("connected");
    });
    const consume = (message, namedType) => {
      if (source !== next || activeSessionId !== sessionId) return;
      try {
        const payload = JSON.parse(message.data);
        if (namedType && !payload.type && !payload.event?.type) payload.type = namedType;
        onEvent(payload);
      } catch {
        onState("unavailable", "Scotty received an unreadable session event");
      }
    };
    next.addEventListener("message", (event) => consume(event));
    for (const type of EVENT_TYPES) next.addEventListener(type, (event) => consume(event, type));
    next.addEventListener("error", () => {
      if (source === next) onState("reconnecting");
    });
  };

  return {
    async open(sessionId) {
      closeTransport();
      activeSessionId = sessionId;
      onState("connecting");
      const controller = new AbortController();
      snapshotController = controller;
      const snapshot = await transport.snapshot(sessionId, controller.signal);
      if (controller.signal.aborted || activeSessionId !== sessionId) return undefined;
      snapshotController = undefined;
      connectEvents(sessionId, snapshot);
      return snapshot;
    },

    close() {
      activeSessionId = undefined;
      closeTransport();
    },

    command(authority, intent, label) {
      if (!activeSessionId || activeSessionId !== authority.sessionId)
        throw new Error("Refresh the active session before sending a command");
      return lane.enqueue({ ...authority, intent, label });
    },

    discard(sessionId) {
      return lane.discard(sessionId);
    },

    laneState(sessionId) {
      return lane.state(sessionId);
    },
  };
}
