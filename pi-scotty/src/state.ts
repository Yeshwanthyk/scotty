import {
  PI_CONSOLE_MAX_MESSAGES,
  PI_CONSOLE_MAX_QUEUE_ITEMS,
  PI_CONSOLE_MAX_STATUSES,
  PI_CONSOLE_MAX_WIDGETS,
  type PiConsoleEventEnvelopeV1,
  type PiConsoleSnapshotV1,
  type PiConsoleUnavailableV1,
} from "../../protocol/pi-console.ts";
import { PiScottyError } from "./errors.ts";
import { redactRemoteString, redactRemoteValue } from "./redaction.ts";
import {
  decodeEventType,
  decodeExtensionUiEvent,
  decodeMessageEvent,
  decodeMessageIdentity,
  decodePendingUiResolutionEvent,
  decodeQueueEvent,
  decodeStreaming,
  decodeToolEvent,
  type FleetSession,
  type SelectedSession,
} from "./schemas.ts";

const MAX_CACHED_SESSIONS = 50;
const MAX_RECENT_EVENTS = 100;
export const SETTLED_TURNS_FOLD_ID = "settled-turns";

export interface ToolProjection {
  readonly id: string;
  readonly name: string;
  readonly arguments?: unknown;
  readonly partialResult?: unknown;
}

export interface ConsoleNotification {
  readonly id: string;
  readonly message: string;
  readonly type: "info" | "warning" | "error";
}

interface MessageProjectionState {
  readonly pending: Array<{ index: number; message: unknown }>;
  readonly overlap: Array<{ index: number; signature: string }>;
}

export interface LiveProjection {
  readonly epoch: string;
  readonly sequence: number;
  readonly sessionRevision: number;
  readonly state: unknown;
  readonly isStreaming: boolean;
  readonly messages: ReadonlyArray<unknown>;
  readonly messageProjection: MessageProjectionState;
  readonly activeTools: ReadonlyMap<string, ToolProjection>;
  readonly queue: PiConsoleSnapshotV1["queue"];
  readonly pendingUi: PiConsoleSnapshotV1["pendingUi"];
  readonly pendingUiAuthority: PiConsoleSnapshotV1["pendingUiAuthority"];
  readonly extensionSurface: PiConsoleSnapshotV1["extensionSurface"];
  readonly capabilities: PiConsoleSnapshotV1["capabilities"];
  readonly truncated: PiConsoleSnapshotV1["truncated"];
  readonly recentEvents: ReadonlyArray<unknown>;
  readonly notifications: ReadonlyArray<ConsoleNotification>;
  readonly activity: "working" | "waiting" | "completed" | "unknown";
}

export type UiAnswerStatus = "in_flight" | "delivered_unconfirmed" | "outcome_unknown";

export interface SessionsPickerState {
  readonly generation: number;
  readonly status: "closed" | "loading" | "open" | "error";
  readonly message?: string;
}

export interface SessionViewCache {
  draft: string;
  draftGeneration: number;
  scroll: number;
  readonly folded: Set<string>;
  metadata?: SelectedSession;
  live?: LiveProjection;
  unavailable?: PiConsoleUnavailableV1;
  error?: string;
  commandStatus?: string;
  outcomeUnknownCommandId?: string;
  readonly uiAnswers: Map<string, UiAnswerStatus>;
  readonly dialogDrafts: Map<string, string>;
  dialogCursor: number;
}

export type EventReduction = "applied" | "duplicate" | "resnapshot";

const toolId = (event: ReturnType<typeof decodeToolEvent>): string | undefined =>
  event?.toolCallId ?? event?.tool_call_id ?? event?.id;

const messageSignature = (message: unknown): string => JSON.stringify(message) ?? "null";
const messageId = (message: unknown): string | undefined => {
  const identity = decodeMessageIdentity(message);
  return identity?.id ?? identity?.messageId ?? identity?.message_id;
};
const sameLifecycleMessage = (left: unknown, right: unknown): boolean => {
  const leftIdentity = decodeMessageIdentity(left);
  const rightIdentity = decodeMessageIdentity(right);
  const leftId = leftIdentity?.id ?? leftIdentity?.messageId ?? leftIdentity?.message_id;
  const rightId = rightIdentity?.id ?? rightIdentity?.messageId ?? rightIdentity?.message_id;
  if (leftId !== undefined || rightId !== undefined)
    return leftId !== undefined && leftId === rightId;
  if (leftIdentity?.role !== rightIdentity?.role) return false;
  if (leftIdentity?.timestamp !== undefined || rightIdentity?.timestamp !== undefined)
    return leftIdentity?.timestamp === rightIdentity?.timestamp;
  return messageSignature(left) === messageSignature(right);
};

const claimSnapshotMessage = (
  projection: MessageProjectionState,
  message: unknown,
): number | undefined => {
  const signature = messageSignature(message);
  const index = projection.overlap.findIndex((candidate) => candidate.signature === signature);
  if (index < 0) return undefined;
  return projection.overlap.splice(index, 1)[0]?.index;
};

const projectMessageEvent = (
  messages: unknown[],
  projection: MessageProjectionState,
  type: "message_start" | "message_update" | "message_end",
  message: unknown,
): void => {
  const identity = decodeMessageIdentity(message);
  const id = messageId(message);
  const idIndex =
    id === undefined ? -1 : messages.findIndex((candidate) => messageId(candidate) === id);

  if (type === "message_update") {
    if (idIndex >= 0) messages[idIndex] = message;
    else {
      const pending = projection.pending.at(-1);
      const lastIndex = messages.length - 1;
      if (pending !== undefined) {
        messages[pending.index] = message;
        pending.message = message;
      } else if (
        identity?.role === "assistant" &&
        decodeMessageIdentity(messages[lastIndex])?.role === "assistant"
      )
        messages[lastIndex] = message;
      else messages.push(message);
    }
    return;
  }

  if (type === "message_start") {
    const overlapIndex = claimSnapshotMessage(projection, message);
    const index = overlapIndex ?? (idIndex >= 0 ? idIndex : messages.push(message) - 1);
    projection.pending.push({ index, message });
    return;
  }

  const pendingIndex = projection.pending.findIndex((candidate) =>
    sameLifecycleMessage(candidate.message, message),
  );
  if (pendingIndex >= 0) {
    const pending = projection.pending.splice(pendingIndex, 1)[0];
    if (pending !== undefined) messages[pending.index] = message;
    return;
  }
  const overlapIndex = claimSnapshotMessage(projection, message);
  if (overlapIndex !== undefined) messages[overlapIndex] = message;
  else if (idIndex >= 0) messages[idIndex] = message;
  else if (
    identity?.role === "assistant" &&
    decodeMessageIdentity(messages.at(-1))?.role === "assistant"
  )
    messages[messages.length - 1] = message;
  else messages.push(message);
};

const boundMessages = (messages: unknown[], projection: MessageProjectionState): void => {
  const removed = Math.max(0, messages.length - PI_CONSOLE_MAX_MESSAGES);
  if (removed === 0) return;
  messages.splice(0, removed);
  for (let index = projection.pending.length - 1; index >= 0; index -= 1)
    if ((projection.pending[index]?.index ?? -1) < removed) projection.pending.splice(index, 1);
  for (const pending of projection.pending) pending.index -= removed;
  for (let index = projection.overlap.length - 1; index >= 0; index -= 1)
    if ((projection.overlap[index]?.index ?? -1) < removed) projection.overlap.splice(index, 1);
  for (const overlap of projection.overlap) overlap.index -= removed;
};

const sanitizeQueue = (queue: PiConsoleSnapshotV1["queue"]): PiConsoleSnapshotV1["queue"] => ({
  steer: queue.steer.slice(0, PI_CONSOLE_MAX_QUEUE_ITEMS).map((item) => ({
    id: redactRemoteString(item.id),
    text: redactRemoteString(item.text),
  })),
  followUp: queue.followUp.slice(0, PI_CONSOLE_MAX_QUEUE_ITEMS).map((item) => ({
    id: redactRemoteString(item.id),
    text: redactRemoteString(item.text),
  })),
});

const eventQueueItems = (items: ReadonlyArray<unknown> | undefined, kind: string) =>
  (items ?? []).slice(0, PI_CONSOLE_MAX_QUEUE_ITEMS).map((item, index) => ({
    id: `${kind}-${index}`,
    text: redactRemoteString(typeof item === "string" ? item : (JSON.stringify(item) ?? "null")),
  }));

const sanitizePendingUi = (
  requests: PiConsoleSnapshotV1["pendingUi"],
): PiConsoleSnapshotV1["pendingUi"] =>
  requests.map((request) => {
    const id = redactRemoteString(request.id);
    const title = redactRemoteString(request.title);
    if (request.method === "select")
      return {
        id,
        title,
        method: request.method,
        options: request.options.map(redactRemoteString),
        ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
      };
    if (request.method === "confirm")
      return {
        id,
        title,
        method: request.method,
        message: redactRemoteString(request.message),
        ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
      };
    if (request.method === "input")
      return {
        id,
        title,
        method: request.method,
        ...(request.placeholder === undefined
          ? {}
          : { placeholder: redactRemoteString(request.placeholder) }),
        ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
      };
    return {
      id,
      title,
      method: request.method,
      ...(request.prefill === undefined ? {} : { prefill: redactRemoteString(request.prefill) }),
    };
  });

const sanitizeExtensionSurface = (
  surface: PiConsoleSnapshotV1["extensionSurface"],
): PiConsoleSnapshotV1["extensionSurface"] => ({
  statuses: Object.fromEntries(
    Object.entries(surface.statuses)
      .slice(0, PI_CONSOLE_MAX_STATUSES)
      .map(([key, value]) => [redactRemoteString(key), redactRemoteString(value)]),
  ),
  widgets: surface.widgets.slice(0, PI_CONSOLE_MAX_WIDGETS).map((widget) => ({
    key: redactRemoteString(widget.key),
    lines: widget.lines.map(redactRemoteString),
    ...(widget.placement === undefined ? {} : { placement: widget.placement }),
  })),
  ...(surface.title === undefined ? {} : { title: redactRemoteString(surface.title) }),
});

const sanitizeCapabilities = (
  capabilities: PiConsoleSnapshotV1["capabilities"],
): PiConsoleSnapshotV1["capabilities"] => ({
  models: capabilities.models.map((model) => ({
    provider: redactRemoteString(model.provider),
    id: redactRemoteString(model.id),
    ...(model.name === undefined ? {} : { name: redactRemoteString(model.name) }),
  })),
  thinkingLevels: capabilities.thinkingLevels.map(redactRemoteString),
  commands: capabilities.commands.map((command) => ({
    name: command.name,
    source: command.source,
    ...(command.description === undefined
      ? {}
      : { description: redactRemoteString(command.description) }),
  })),
});

const reduceEvent = (
  current: LiveProjection,
  envelope: PiConsoleEventEnvelopeV1,
): { readonly state: LiveProjection; readonly result: EventReduction } => {
  const rawType = decodeEventType(envelope.event)?.type;
  if (envelope.epoch !== current.epoch || rawType === "scotty_epoch_changed")
    return { state: current, result: "resnapshot" };
  if (envelope.sequence <= current.sequence) return { state: current, result: "duplicate" };
  if (envelope.sequence !== current.sequence + 1 || rawType === "scotty_replay_gap")
    return { state: current, result: "resnapshot" };

  const event = redactRemoteValue(envelope.event);
  const type = decodeEventType(event)?.type;
  const tools = new Map(current.activeTools);
  const tool = decodeToolEvent(event);
  const id = toolId(tool);
  if (tool?.type === "tool_execution_end" && id !== undefined) tools.delete(id);
  if (
    (tool?.type === "tool_execution_start" || tool?.type === "tool_execution_update") &&
    id !== undefined
  ) {
    const previous = tools.get(id);
    tools.set(id, {
      id: redactRemoteString(id),
      name: redactRemoteString(tool.toolName ?? tool.name ?? previous?.name ?? "tool"),
      arguments: redactRemoteValue(tool.args ?? tool.arguments ?? previous?.arguments),
      partialResult: redactRemoteValue(
        tool.partialResult ?? tool.output ?? previous?.partialResult,
      ),
    });
  }

  const messages = [...current.messages];
  const messageProjection: MessageProjectionState = {
    pending: current.messageProjection.pending.map((pending) => ({ ...pending })),
    overlap: current.messageProjection.overlap.map((overlap) => ({ ...overlap })),
  };
  const messageEvent = decodeMessageEvent(event);
  if (messageEvent?.message !== undefined) {
    projectMessageEvent(messages, messageProjection, messageEvent.type, messageEvent.message);
    boundMessages(messages, messageProjection);
  }

  const recentEvents = [...current.recentEvents, event];
  if (recentEvents.length > MAX_RECENT_EVENTS)
    recentEvents.splice(0, recentEvents.length - MAX_RECENT_EVENTS);

  let queue = current.queue;
  const queueEvent = decodeQueueEvent(event);
  if (queueEvent !== undefined)
    queue = {
      steer: eventQueueItems(queueEvent.steering ?? queueEvent.steer, "steer"),
      followUp: eventQueueItems(queueEvent.followUp ?? queueEvent.follow_up, "follow-up"),
    };

  let pendingUi: PiConsoleSnapshotV1["pendingUi"] = [...current.pendingUi];
  let extensionSurface = current.extensionSurface;
  let notifications = [...current.notifications];
  const ui = decodeExtensionUiEvent(event);
  if (ui !== undefined) {
    if (
      ui.method === "select" ||
      ui.method === "confirm" ||
      ui.method === "input" ||
      ui.method === "editor"
    ) {
      const { type: _, ...request } = ui;
      pendingUi = sanitizePendingUi([
        ...pendingUi.filter((pending) => pending.id !== ui.id),
        request,
      ]);
    } else if (ui.method === "notify") {
      notifications.push({
        id: redactRemoteString(ui.id),
        message: redactRemoteString(ui.message),
        type: ui.notifyType ?? "info",
      });
      if (notifications.length > 20) notifications = notifications.slice(-20);
    } else if (ui.method === "setStatus") {
      const key = redactRemoteString(ui.statusKey);
      const statuses = Object.entries(extensionSurface.statuses).filter(([name]) => name !== key);
      if (typeof ui.statusText === "string")
        statuses.push([key, redactRemoteString(ui.statusText)]);
      extensionSurface = {
        ...extensionSurface,
        statuses: Object.fromEntries(statuses.slice(-PI_CONSOLE_MAX_STATUSES)),
      };
    } else if (ui.method === "setWidget") {
      const key = redactRemoteString(ui.widgetKey);
      const widgets = extensionSurface.widgets.filter((widget) => widget.key !== key);
      if (Array.isArray(ui.widgetLines))
        widgets.push({
          key,
          lines: ui.widgetLines.map(redactRemoteString),
          ...(ui.widgetPlacement === undefined ? {} : { placement: ui.widgetPlacement }),
        });
      extensionSurface = { ...extensionSurface, widgets: widgets.slice(-PI_CONSOLE_MAX_WIDGETS) };
    } else if (ui.method === "setTitle") {
      extensionSurface = { ...extensionSurface, title: redactRemoteString(ui.title) };
    }
  }

  const resolution = decodePendingUiResolutionEvent(event);
  if (resolution !== undefined)
    pendingUi = pendingUi.filter((request) => request.id !== resolution.id);
  const settled =
    type === "agent_settled" ||
    type === "agent_end" ||
    type === "turn_end" ||
    type === "agent_abort" ||
    type === "agent_aborted" ||
    type === "turn_abort" ||
    type === "turn_aborted" ||
    type === "scotty_process_exit";
  if (settled) {
    pendingUi = [];
    tools.clear();
    queue = { steer: [], followUp: [] };
  }

  const isStreaming =
    type === "agent_start" || type === "turn_start" ? true : settled ? false : current.isStreaming;
  const activity = pendingUi.length > 0 ? "waiting" : !isStreaming ? "completed" : "working";

  return {
    state: {
      ...current,
      sequence: envelope.sequence,
      isStreaming,
      messages,
      messageProjection,
      activeTools: tools,
      queue,
      pendingUi,
      extensionSurface,
      recentEvents,
      notifications,
      activity,
    },
    result: "applied",
  };
};

export const hydrateSnapshot = (snapshot: PiConsoleSnapshotV1): LiveProjection => {
  const overlap = snapshot.overlapEvents;
  const contiguous =
    overlap.length === snapshot.sequence - snapshot.baseSequence &&
    overlap.every(
      (envelope, index) =>
        envelope.epoch === snapshot.epoch &&
        envelope.sequence === snapshot.baseSequence + index + 1,
    );
  if (!contiguous)
    throw new PiScottyError("response_invalid", "Console snapshot overlap was not contiguous");

  const tools = new Map<string, ToolProjection>();
  for (const tool of snapshot.activeTools) {
    const id = redactRemoteString(tool.id);
    tools.set(id, {
      id,
      name: redactRemoteString(tool.name),
      arguments: redactRemoteValue(tool.arguments),
      partialResult: redactRemoteValue(tool.partialResult),
    });
  }

  const state = redactRemoteValue(snapshot.state);
  const messages = snapshot.messages
    .map((message) => redactRemoteValue(message))
    .slice(-PI_CONSOLE_MAX_MESSAGES);
  const pendingUi = sanitizePendingUi(snapshot.pendingUi);
  let live: LiveProjection = {
    epoch: snapshot.epoch,
    sequence: snapshot.baseSequence,
    sessionRevision: snapshot.sessionRevision,
    state,
    isStreaming: decodeStreaming(state),
    messages,
    messageProjection: {
      pending: [],
      overlap: messages.map((message, index) => ({ index, signature: messageSignature(message) })),
    },
    activeTools: tools,
    queue: sanitizeQueue(snapshot.queue),
    pendingUi,
    pendingUiAuthority: snapshot.pendingUiAuthority,
    extensionSurface: sanitizeExtensionSurface(snapshot.extensionSurface),
    capabilities: sanitizeCapabilities(snapshot.capabilities),
    truncated: snapshot.truncated,
    recentEvents: [],
    notifications: [],
    activity: pendingUi.length > 0 ? "waiting" : decodeStreaming(state) ? "working" : "completed",
  };
  for (const envelope of overlap) {
    const reduced = reduceEvent(live, envelope);
    if (reduced.result !== "applied")
      throw new PiScottyError("response_invalid", "Console snapshot overlap could not be reduced");
    live = reduced.state;
  }
  live.messageProjection.overlap.splice(0);
  return live;
};

export class FleetConsoleState {
  fleet: ReadonlyArray<FleetSession> = [];
  selectedSessionId: string | undefined;
  fleetCursor = 0;
  loading = false;
  fleetError: string | undefined;
  sessionsPicker: SessionsPickerState = { generation: 0, status: "closed" };
  readonly #caches = new Map<string, SessionViewCache>();

  cache(sessionId: string): SessionViewCache {
    const existing = this.#caches.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionViewCache = {
      draft: "",
      draftGeneration: 0,
      scroll: 0,
      folded: new Set(),
      uiAnswers: new Map(),
      dialogDrafts: new Map(),
      dialogCursor: 0,
    };
    this.#caches.set(sessionId, created);
    while (this.#caches.size > MAX_CACHED_SESSIONS) {
      const oldest = this.#caches.keys().next().value;
      if (oldest !== undefined && oldest !== this.selectedSessionId) this.#caches.delete(oldest);
      else break;
    }
    return created;
  }

  moveFleetCursor(delta: number): void {
    if (this.fleet.length === 0) {
      this.fleetCursor = 0;
      return;
    }
    this.fleetCursor = Math.max(0, Math.min(this.fleet.length - 1, this.fleetCursor + delta));
  }

  selectLocal(sessionId: string): void {
    this.selectedSessionId = sessionId;
    this.loading = true;
    const cache = this.cache(sessionId);
    cache.error = undefined;
  }

  closeLocal(): void {
    this.selectedSessionId = undefined;
    this.loading = false;
    this.closeSessionsPicker();
  }

  beginSessionsPicker(): number {
    const generation = this.sessionsPicker.generation + 1;
    this.sessionsPicker = { generation, status: "loading" };
    return generation;
  }

  openSessionsPicker(generation: number): void {
    if (this.sessionsPicker.generation !== generation) return;
    this.sessionsPicker = { generation, status: "open" };
  }

  failSessionsPicker(generation: number, message: string): void {
    if (this.sessionsPicker.generation !== generation) return;
    this.sessionsPicker = { generation, status: "error", message };
  }

  markSessionsPickerUnavailable(message: string): void {
    if (this.sessionsPicker.status !== "open") return;
    this.sessionsPicker = { ...this.sessionsPicker, message };
  }

  closeSessionsPicker(): void {
    this.sessionsPicker = {
      generation: this.sessionsPicker.generation + 1,
      status: "closed",
    };
  }

  setFleet(fleet: ReadonlyArray<FleetSession>): void {
    this.fleet = fleet;
    this.fleetCursor = Math.max(0, Math.min(this.fleetCursor, Math.max(0, fleet.length - 1)));
    this.fleetError = undefined;
  }

  setMetadata(sessionId: string, metadata: SelectedSession): void {
    this.cache(sessionId).metadata = metadata;
  }

  setReadOnly(sessionId: string): void {
    const cache = this.cache(sessionId);
    cache.live = undefined;
    cache.unavailable = undefined;
    cache.error = undefined;
    if (this.selectedSessionId === sessionId) this.loading = false;
  }

  setSnapshot(sessionId: string, snapshot: PiConsoleSnapshotV1): void {
    const cache = this.cache(sessionId);
    cache.live = hydrateSnapshot(snapshot);
    this.reconcileUiAnswers(cache, true);
    cache.unavailable = undefined;
    cache.error = undefined;
    if (this.selectedSessionId === sessionId) this.loading = false;
  }

  setUnavailable(sessionId: string, unavailable: PiConsoleUnavailableV1): void {
    const cache = this.cache(sessionId);
    cache.live = undefined;
    cache.unavailable = unavailable;
    cache.error = undefined;
    if (this.selectedSessionId === sessionId) this.loading = false;
  }

  setError(sessionId: string, message: string): void {
    this.cache(sessionId).error = message;
    if (this.selectedSessionId === sessionId) this.loading = false;
  }

  applyEvent(sessionId: string, envelope: PiConsoleEventEnvelopeV1): EventReduction {
    const cache = this.cache(sessionId);
    const ui = decodeExtensionUiEvent(envelope.event);
    if (ui?.method === "set_editor_text") {
      cache.draft = redactRemoteString(ui.text);
      cache.draftGeneration += 1;
    }
    if (cache.live === undefined) return "resnapshot";
    const reduced = reduceEvent(cache.live, envelope);
    cache.live = reduced.state;
    this.reconcileUiAnswers(cache, false);
    return reduced.result;
  }

  setDraft(sessionId: string, draft: string): void {
    const cache = this.cache(sessionId);
    cache.draft = redactRemoteString(draft);
    cache.draftGeneration += 1;
  }

  scroll(sessionId: string, delta: number): void {
    const cache = this.cache(sessionId);
    cache.scroll = Math.max(0, Math.min(PI_CONSOLE_MAX_MESSAGES - 1, cache.scroll + delta));
  }

  removePendingUi(sessionId: string, requestId: string): void {
    const cache = this.cache(sessionId);
    if (cache.live === undefined) return;
    const pendingUi = cache.live.pendingUi.filter((request) => request.id !== requestId);
    cache.live = {
      ...cache.live,
      pendingUi,
      activity: pendingUi.length > 0 ? "waiting" : cache.live.isStreaming ? "working" : "completed",
    };
  }

  private reconcileUiAnswers(cache: SessionViewCache, freshSnapshot: boolean): void {
    const live = cache.live;
    if (live === undefined) return;
    const prefix = `${live.epoch}\0`;
    const pending = new Set(live.pendingUi.map((request) => `${prefix}${request.id}`));
    for (const [identity, status] of cache.uiAnswers) {
      if (
        !identity.startsWith(prefix) ||
        !pending.has(identity) ||
        (freshSnapshot && status === "outcome_unknown")
      )
        cache.uiAnswers.delete(identity);
    }
  }

  toggleFold(sessionId: string, targetId: string): void {
    const folded = this.cache(sessionId).folded;
    if (folded.has(targetId)) folded.delete(targetId);
    else folded.add(redactRemoteString(targetId));
  }
}
