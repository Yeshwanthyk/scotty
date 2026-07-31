function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function messageId(message) {
  return firstString(message?.id, message?.messageId, message?.message_id);
}

function messageSignature(message) {
  return JSON.stringify(message);
}

function isSameLifecycleMessage(left, right) {
  const leftId = messageId(left);
  const rightId = messageId(right);
  if (leftId || rightId) return leftId !== undefined && leftId === rightId;
  if (left?.role !== right?.role) return false;
  const leftTimestamp = left?.timestamp;
  const rightTimestamp = right?.timestamp;
  if (typeof leftTimestamp === "number" || typeof leftTimestamp === "string") {
    return leftTimestamp === rightTimestamp;
  }
  return messageSignature(left) === messageSignature(right);
}

export function createMessageProjectionState(messages = [], reconcileSnapshot = false) {
  return {
    pending: [],
    overlap: reconcileSnapshot
      ? messages.map((message, index) => ({ index, signature: messageSignature(message) }))
      : [],
  };
}

export function finishMessageSnapshot(state) {
  state.overlap = [];
}

function claimSnapshotMessage(state, message) {
  const signature = messageSignature(message);
  const overlapIndex = state.overlap.findIndex((candidate) => candidate.signature === signature);
  if (overlapIndex < 0) return undefined;
  return state.overlap.splice(overlapIndex, 1)[0].index;
}

function upsertAssistantMessage(messages, message) {
  const id = messageId(message);
  const idIndex = id ? messages.findIndex((candidate) => messageId(candidate) === id) : -1;
  if (idIndex >= 0) {
    messages[idIndex] = message;
    return;
  }

  const lastIndex = messages.length - 1;
  if (!id && messages[lastIndex]?.role === "assistant" && message.role === "assistant") {
    messages[lastIndex] = message;
    return;
  }

  messages.push(message);
}

export function projectMessageEvent(messages, state, type, message) {
  if (message.role === "assistant" || type === "message_update") {
    upsertAssistantMessage(messages, message);
    return;
  }

  if (type === "message_start") {
    const overlapIndex = claimSnapshotMessage(state, message);
    const index = overlapIndex ?? messages.push(message) - 1;
    state.pending.push({ index, message });
    return;
  }

  const pendingIndex = state.pending.findIndex((candidate) =>
    isSameLifecycleMessage(candidate.message, message),
  );
  if (pendingIndex >= 0) {
    const pending = state.pending.splice(pendingIndex, 1)[0];
    messages[pending.index] = message;
    return;
  }

  const overlapIndex = claimSnapshotMessage(state, message);
  if (overlapIndex !== undefined) {
    messages[overlapIndex] = message;
    return;
  }

  const id = messageId(message);
  const idIndex = id ? messages.findIndex((candidate) => messageId(candidate) === id) : -1;
  if (idIndex >= 0) messages[idIndex] = message;
  else messages.push(message);
}
