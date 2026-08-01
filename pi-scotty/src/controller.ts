import {
  PI_CONSOLE_PROTOCOL_VERSION,
  type PiConsoleCommandV1,
  type PiConsoleRemoteIntentV1,
} from "../../protocol/pi-console.ts";
import { safeErrorMessage } from "./errors.ts";
import { decodeSnapshot, decodeUnavailable } from "./schemas.ts";
import { FleetConsoleState, SETTLED_TURNS_FOLD_ID } from "./state.ts";
import type { ConsoleTransport } from "./transport.ts";

const MAX_UI_ANSWER_STATES = 100;

export type IntentSubmission = {
  readonly commandId: string;
  readonly outcome: "accepted" | "delivered" | "rejected" | "stale" | "not_accepted" | "ambiguous";
};

export type ReconnectDelay = (attempt: number, signal: AbortSignal) => Promise<boolean>;

const reconnectDelay: ReconnectDelay = (attempt, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const delay = Math.min(5_000, 250 * 2 ** Math.min(attempt, 5));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delay);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export type ComposerRoute =
  | { readonly type: "empty" }
  | { readonly type: "local_error"; readonly message: string }
  | { readonly type: "fold" }
  | { readonly type: "remote"; readonly intent: PiConsoleRemoteIntentV1 };

export const routeComposerSubmission = (
  text: string,
  streaming: boolean,
  forceFollowUp = false,
): ComposerRoute => {
  const message = text.trim();
  if (message.length === 0) return { type: "empty" };
  if (message.startsWith("/")) {
    if (message === "/fold") return { type: "fold" };
    if (message === "/subagents")
      return { type: "remote", intent: { type: "slash_command", name: "subagents" } };
    const workflows = /^\/workflows(?:\s+(\S+))?$/u.exec(message);
    if (workflows !== null) {
      const runId = workflows[1];
      if (runId !== undefined && !/^wf_[0-9a-f]{12}$/u.test(runId))
        return {
          type: "local_error",
          message: "Workflow run IDs must match wf_<12 lowercase hex characters>",
        };
      return {
        type: "remote",
        intent: {
          type: "slash_command",
          name: "workflows",
          ...(runId === undefined ? {} : { arguments: runId }),
        },
      };
    }
    return {
      type: "local_error",
      message: "Only /subagents, /workflows [runId], and /fold are available",
    };
  }
  return {
    type: "remote",
    intent: forceFollowUp
      ? { type: "follow_up", message }
      : streaming
        ? { type: "steer", message }
        : { type: "prompt", message },
  };
};

export class FleetConsoleController {
  readonly state: FleetConsoleState;
  readonly #transport: ConsoleTransport;
  readonly #onChange: () => void;
  readonly #commandId: () => string;
  readonly #reconnectDelay: ReconnectDelay;
  #generation = 0;
  #eventsAbort: AbortController | undefined;

  constructor(
    transport: ConsoleTransport,
    state = new FleetConsoleState(),
    onChange: () => void = () => undefined,
    commandId: () => string = () => crypto.randomUUID(),
    delay: ReconnectDelay = reconnectDelay,
  ) {
    this.#transport = transport;
    this.state = state;
    this.#onChange = onChange;
    this.#commandId = commandId;
    this.#reconnectDelay = delay;
  }

  async loadFleet(): Promise<void> {
    try {
      this.state.setFleet(await this.#transport.listFleet());
    } catch (error) {
      this.state.fleetError = safeErrorMessage(error);
    }
    this.#onChange();
  }

  moveFleetCursor(delta: number): void {
    this.state.moveFleetCursor(delta);
    this.#onChange();
  }

  async openCursor(): Promise<void> {
    const session = this.state.fleet[this.state.fleetCursor];
    if (session === undefined) return;
    if (session.status !== "warm" || session.provider !== "cloudflare") {
      this.state.fleetError = "Only warm Cloudflare sessions can be opened";
      this.#onChange();
      return;
    }
    await this.select(session.id);
  }

  async select(sessionId: string): Promise<void> {
    this.#eventsAbort?.abort();
    const abort = new AbortController();
    this.#eventsAbort = abort;
    const generation = ++this.#generation;
    this.state.selectLocal(sessionId);
    this.#onChange();

    try {
      const metadata = await this.#transport.getSelected(sessionId, abort.signal);
      if (!this.#isCurrent(sessionId, generation)) return;
      this.state.setMetadata(sessionId, metadata);
      this.#onChange();
      await this.#loadSnapshot(sessionId, generation, abort);
    } catch (error) {
      if (!abort.signal.aborted && this.#isCurrent(sessionId, generation)) {
        this.state.setError(sessionId, safeErrorMessage(error));
        this.#onChange();
      }
    }
  }

  closeLocal(): void {
    this.#generation += 1;
    this.#eventsAbort?.abort();
    this.#eventsAbort = undefined;
    this.state.closeLocal();
    this.#onChange();
  }

  async submitDraft(forceFollowUp = false): Promise<void> {
    const sessionId = this.state.selectedSessionId;
    if (sessionId === undefined) return;
    const cache = this.state.cache(sessionId);
    const route = routeComposerSubmission(
      cache.draft,
      cache.live?.isStreaming ?? false,
      forceFollowUp,
    );
    if (route.type === "empty") return;
    if (route.type === "local_error") {
      cache.commandStatus = route.message;
      this.#onChange();
      return;
    }
    if (route.type === "fold") {
      this.state.toggleFold(sessionId, SETTLED_TURNS_FOLD_ID);
      cache.commandStatus = cache.folded.has(SETTLED_TURNS_FOLD_ID)
        ? "Settled turns folded locally"
        : "Settled turns expanded locally";
      cache.draft = "";
      this.#onChange();
      return;
    }
    await this.sendIntent(route.intent, true);
  }

  async abortActive(): Promise<void> {
    const sessionId = this.state.selectedSessionId;
    if (sessionId === undefined) return;
    const cache = this.state.cache(sessionId);
    if (cache.live?.isStreaming) await this.sendIntent({ type: "abort" }, false);
  }

  async answerExtensionUi(
    requestId: string,
    answer:
      | { readonly value: string }
      | { readonly confirmed: boolean }
      | { readonly cancelled: true },
  ): Promise<void> {
    const sessionId = this.state.selectedSessionId;
    if (sessionId === undefined) return;
    const cache = this.state.cache(sessionId);
    const live = cache.live;
    if (live === undefined || !live.pendingUi.some((request) => request.id === requestId)) return;
    const identity = `${live.epoch}\0${requestId}`;
    if (cache.uiAnswers.has(identity)) return;
    cache.uiAnswers.set(identity, "in_flight");
    this.#onChange();
    const submission = await this.sendIntent(
      { type: "extension_ui_response", id: requestId, ...answer },
      false,
    );
    if (submission.outcome === "accepted" || submission.outcome === "delivered") {
      cache.uiAnswers.set(identity, "delivered_unconfirmed");
      while (cache.uiAnswers.size > MAX_UI_ANSWER_STATES) {
        const oldest = cache.uiAnswers.keys().next().value;
        if (oldest === undefined) break;
        cache.uiAnswers.delete(oldest);
      }
    } else if (submission.outcome === "ambiguous") {
      cache.uiAnswers.set(identity, "outcome_unknown");
    } else {
      cache.uiAnswers.delete(identity);
    }
    this.#onChange();
  }

  async sendIntent(
    intent: PiConsoleRemoteIntentV1,
    clearDraft: boolean,
  ): Promise<IntentSubmission> {
    const sessionId = this.state.selectedSessionId;
    if (sessionId === undefined) return { commandId: "none", outcome: "not_accepted" };
    const cache = this.state.cache(sessionId);
    const live = cache.live;
    if (live === undefined) {
      cache.commandStatus = "Live session state is unavailable";
      this.#onChange();
      return { commandId: "none", outcome: "not_accepted" };
    }
    const command: PiConsoleCommandV1 = {
      version: PI_CONSOLE_PROTOCOL_VERSION,
      epoch: live.epoch,
      commandId: this.#commandId(),
      expectedSessionRevision: live.sessionRevision,
      intent,
    };
    cache.commandStatus = "Sending…";
    cache.outcomeUnknownCommandId = undefined;
    this.#onChange();

    try {
      const result = await this.#transport.postCommand(sessionId, command);
      if (result.status === "stale") {
        cache.commandStatus = "Session changed; refreshed. Submit again to send.";
        await this.#resnapshot(sessionId);
        return { commandId: command.commandId, outcome: "stale" };
      }
      if (result.status === "unavailable") {
        cache.commandStatus = `Command not accepted: ${result.reason}`;
        this.#onChange();
        return { commandId: command.commandId, outcome: "not_accepted" };
      }
      if (result.status === "error") {
        cache.commandStatus = `Command not accepted: ${result.code}`;
        this.#onChange();
        return { commandId: command.commandId, outcome: "not_accepted" };
      }
      const uiDeliveryUnconfirmed =
        intent.type === "extension_ui_response" &&
        (result.status === "accepted" || result.status === "delivered");
      cache.commandStatus = uiDeliveryUnconfirmed
        ? "Delivered to Pi; awaiting continuation (outcome unconfirmed)"
        : result.status === "accepted"
          ? "Command accepted"
          : result.status === "delivered"
            ? "Delivered to Pi; awaiting continuation (outcome unconfirmed)"
            : "Command rejected by supervisor";
      if (clearDraft && result.status === "accepted") cache.draft = "";
      this.#onChange();
      return {
        commandId: command.commandId,
        outcome: uiDeliveryUnconfirmed
          ? "delivered"
          : result.status === "accepted"
            ? "accepted"
            : result.status === "delivered"
              ? "delivered"
              : "rejected",
      };
    } catch {
      cache.outcomeUnknownCommandId = command.commandId;
      cache.commandStatus = `Outcome unknown (${command.commandId}); refreshing passively`;
      this.#onChange();
      await this.#resnapshot(sessionId);
      return { commandId: command.commandId, outcome: "ambiguous" };
    }
  }

  stop(): void {
    this.closeLocal();
  }

  readonly #isCurrent = (sessionId: string, generation: number): boolean =>
    generation === this.#generation && this.state.selectedSessionId === sessionId;

  async #resnapshot(sessionId: string): Promise<void> {
    if (this.state.selectedSessionId !== sessionId) return;
    this.#eventsAbort?.abort();
    const abort = new AbortController();
    this.#eventsAbort = abort;
    const generation = ++this.#generation;
    try {
      await this.#loadSnapshot(sessionId, generation, abort);
    } catch (error) {
      if (!abort.signal.aborted && this.#isCurrent(sessionId, generation)) {
        this.state.setError(sessionId, safeErrorMessage(error));
        this.#onChange();
      }
    }
  }

  async #loadSnapshot(
    sessionId: string,
    generation: number,
    abort: AbortController,
  ): Promise<void> {
    const snapshot = await this.#transport.getSnapshot(sessionId, abort.signal);
    if (!this.#isCurrent(sessionId, generation)) return;
    const unavailable = decodeUnavailable(snapshot);
    if (unavailable !== undefined) {
      this.state.setUnavailable(sessionId, unavailable);
      this.#onChange();
      return;
    }
    const liveSnapshot = decodeSnapshot(snapshot);
    if (liveSnapshot === undefined) return;
    this.state.setSnapshot(sessionId, liveSnapshot);
    this.#onChange();
    void this.#consumeEvents(
      sessionId,
      liveSnapshot.epoch,
      liveSnapshot.sequence,
      generation,
      abort,
    );
  }

  async #consumeEvents(
    sessionId: string,
    epoch: string,
    sequence: number,
    generation: number,
    abort: AbortController,
  ): Promise<void> {
    let currentEpoch = epoch;
    let currentSequence = sequence;
    let reconnectAttempt = 0;
    while (!abort.signal.aborted && this.#isCurrent(sessionId, generation)) {
      let receivedEvent = false;
      let resnapshotImmediately = false;
      try {
        for await (const envelope of this.#transport.streamEvents(
          sessionId,
          currentEpoch,
          currentSequence,
          abort.signal,
        )) {
          if (!this.#isCurrent(sessionId, generation)) return;
          receivedEvent = true;
          const result = this.state.applyEvent(sessionId, envelope);
          this.#onChange();
          if (result === "resnapshot") {
            resnapshotImmediately = true;
            break;
          }
          if (result === "applied") currentSequence = envelope.sequence;
        }
      } catch (error) {
        if (abort.signal.aborted || !this.#isCurrent(sessionId, generation)) return;
        this.state.cache(sessionId).error = `${safeErrorMessage(error)}; reconnecting`;
        this.#onChange();
      }
      if (abort.signal.aborted || !this.#isCurrent(sessionId, generation)) return;

      if (!resnapshotImmediately) {
        if (receivedEvent) reconnectAttempt = 0;
        this.state.cache(sessionId).error = "Console event stream ended; reconnecting";
        this.#onChange();
        const continueReconnect = await this.#reconnectDelay(reconnectAttempt, abort.signal);
        reconnectAttempt = Math.min(reconnectAttempt + 1, 6);
        if (!continueReconnect || !this.#isCurrent(sessionId, generation)) return;
      }

      try {
        const snapshot = await this.#transport.getSnapshot(sessionId, abort.signal);
        if (!this.#isCurrent(sessionId, generation)) return;
        const unavailable = decodeUnavailable(snapshot);
        if (unavailable !== undefined) {
          this.state.setUnavailable(sessionId, unavailable);
          this.#onChange();
          return;
        }
        const liveSnapshot = decodeSnapshot(snapshot);
        if (liveSnapshot === undefined) {
          this.state.setError(sessionId, "Console snapshot response was invalid");
          this.#onChange();
          return;
        }
        this.state.setSnapshot(sessionId, liveSnapshot);
        currentEpoch = liveSnapshot.epoch;
        currentSequence = liveSnapshot.sequence;
        this.#onChange();
      } catch (error) {
        if (abort.signal.aborted || !this.#isCurrent(sessionId, generation)) return;
        this.state.cache(sessionId).error = `${safeErrorMessage(error)}; reconnecting`;
        this.#onChange();
        const continueReconnect = await this.#reconnectDelay(reconnectAttempt, abort.signal);
        reconnectAttempt = Math.min(reconnectAttempt + 1, 6);
        if (!continueReconnect || !this.#isCurrent(sessionId, generation)) return;
      }
    }
  }
}
