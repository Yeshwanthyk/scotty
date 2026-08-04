import { describe, expect, it } from "vitest";
import type {
  PiConsoleCommandV1,
  PiConsoleEventEnvelopeV1,
  PiConsoleSnapshotV1,
} from "../../protocol/pi-console.ts";
import { commandIntentDigest } from "../../protocol/pi-console-shared.mjs";
import { FleetConsoleController, routeComposerSubmission } from "../src/controller.ts";
import type { CommandResult, ConsoleTransport } from "../src/transport.ts";
import { SESSION_A, SESSION_B, session, snapshot } from "./fixtures.ts";

const COMMAND_ID = "123e4567-e89b-42d3-a456-426614174000";
const IMAGE = { type: "image", data: "AA==", mimeType: "image/png" } as const;

class FakeConsoleTransport implements ConsoleTransport {
  readonly reads: string[] = [];
  readonly commands: PiConsoleCommandV1[] = [];
  remoteLifecycleMutations = 0;
  commandMode: "accepted" | "rejected" | "stale" | "ambiguous" = "accepted";
  snapshotRevision = 7;
  selectedStatus: "warm" | "sleeping" | "failed" = "warm";
  streamMode: "wait" | "eof_once" | "eof" = "wait";
  streamCalls = 0;
  pendingUi: PiConsoleSnapshotV1["pendingUi"] = [];
  fleet = [session(SESSION_A), session(SESSION_B)];
  listGate: Promise<void> | undefined;
  listError: Error | undefined;

  readonly listFleet = async () => {
    this.reads.push("GET /api/sessions");
    await this.listGate;
    if (this.listError !== undefined) throw this.listError;
    return this.fleet;
  };

  readonly getSelected = async (sessionId: string) => {
    this.reads.push(`GET /api/sessions/${sessionId}`);
    return session(sessionId, { status: this.selectedStatus });
  };

  readonly getSnapshot = async (sessionId: string) => {
    this.reads.push(`GET /s/${sessionId}/console/v1/snapshot`);
    return {
      ...snapshot(sessionId === SESSION_A ? this.snapshotRevision : 11),
      pendingUi: this.pendingUi,
    };
  };

  readonly streamEvents = async function* (
    this: FakeConsoleTransport,
    sessionId: string,
    epoch: string,
    since: number,
    signal: AbortSignal,
  ): AsyncIterable<PiConsoleEventEnvelopeV1> {
    this.streamCalls += 1;
    this.reads.push(`GET /s/${sessionId}/console/v1/events?epoch=${epoch}&since=${since}`);
    if (this.streamMode === "eof" || (this.streamMode === "eof_once" && this.streamCalls === 1))
      return;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    yield* [];
  };

  readonly postCommand = async (
    _sessionId: string,
    command: PiConsoleCommandV1,
  ): Promise<CommandResult> => {
    this.commands.push(command);
    if (this.commandMode === "ambiguous") throw new Error("connection reset");
    if (this.commandMode === "stale") {
      this.snapshotRevision = 8;
      return {
        version: 1,
        status: "stale",
        expectedSessionRevision: command.expectedSessionRevision,
        sessionRevision: 8,
        retryable: false,
      };
    }
    const delivered =
      this.commandMode === "accepted" && command.intent.type === "extension_ui_response";
    return {
      version: 1,
      epoch: command.epoch,
      commandId: command.commandId,
      commandDigest: await commandIntentDigest(command.intent),
      status: this.commandMode === "rejected" ? "rejected" : delivered ? "delivered" : "accepted",
      response:
        this.commandMode === "rejected"
          ? { success: false }
          : delivered
            ? { delivery: "unconfirmed" }
            : { success: true },
    };
  };
}

const open = async (
  transport = new FakeConsoleTransport(),
  delay?: ConstructorParameters<typeof FleetConsoleController>[4],
) => {
  const controller = new FleetConsoleController(
    transport,
    undefined,
    undefined,
    () => COMMAND_ID,
    delay,
  );
  await controller.loadFleet();
  await controller.openCursor();
  await Promise.resolve();
  return { controller, transport };
};

describe("composer routing", () => {
  it("routes idle, streaming, and forced follow-up text", () => {
    expect(routeComposerSubmission("hello", false)).toEqual({
      type: "remote",
      intent: { type: "prompt", message: "hello" },
    });
    expect(routeComposerSubmission("adjust", true)).toEqual({
      type: "remote",
      intent: { type: "steer", message: "adjust" },
    });
    expect(routeComposerSubmission("next", true, true)).toEqual({
      type: "remote",
      intent: { type: "follow_up", message: "next" },
    });
    expect(routeComposerSubmission("inspect", false, false, [IMAGE])).toEqual({
      type: "remote",
      intent: { type: "prompt", message: "inspect", images: [IMAGE] },
    });
    expect(routeComposerSubmission("adjust", true, false, [IMAGE])).toEqual({
      type: "remote",
      intent: { type: "steer", message: "adjust", images: [IMAGE] },
    });
    expect(routeComposerSubmission("next", true, true, [IMAGE])).toEqual({
      type: "remote",
      intent: { type: "follow_up", message: "next", images: [IMAGE] },
    });
    expect(routeComposerSubmission("", false, false, [IMAGE])).toEqual({
      type: "remote",
      intent: { type: "prompt", message: "", images: [IMAGE] },
    });
  });

  it("allows only the strict remote slash surface and local fold", () => {
    expect(routeComposerSubmission("/subagents", false)).toEqual({
      type: "remote",
      intent: { type: "slash_command", name: "subagents" },
    });
    expect(routeComposerSubmission("/workflows wf_abcdef012345", false)).toEqual({
      type: "remote",
      intent: {
        type: "slash_command",
        name: "workflows",
        arguments: "wf_abcdef012345",
      },
    });
    expect(routeComposerSubmission("/fold", false)).toEqual({ type: "fold" });
    expect(routeComposerSubmission("/sessions", false)).toEqual({ type: "sessions" });
    for (const command of [
      "/help",
      "/abort",
      "/sessions extra",
      "/subagents active",
      "/workflows one two",
    ])
      expect(routeComposerSubmission(command, false).type).toBe("local_error");
    expect(routeComposerSubmission("/sessions extra", false)).toEqual({
      type: "local_error",
      message: "Only /sessions, /subagents, /workflows [runId], and /fold are available",
    });
    expect(routeComposerSubmission("/subagents", false, false, [IMAGE])).toEqual({
      type: "local_error",
      message: "Images cannot be attached to slash commands",
    });
  });
});

describe("FleetConsoleController", () => {
  it("starts on fleet, moves only a local cursor, and opens explicitly", async () => {
    const transport = new FakeConsoleTransport();
    const controller = new FleetConsoleController(transport);

    await controller.loadFleet();
    expect(controller.state.selectedSessionId).toBeUndefined();
    controller.moveFleetCursor(1);
    expect(controller.state.fleetCursor).toBe(1);
    expect(transport.reads).toEqual(["GET /api/sessions"]);

    await controller.openCursor();
    expect(controller.state.selectedSessionId).toBe(SESSION_B);
    expect(transport.commands).toEqual([]);
    expect(transport.remoteLifecycleMutations).toBe(0);
    controller.stop();
  });

  it("inspects a sleeping sandbox without attaching its console or changing lifecycle", async () => {
    const transport = new FakeConsoleTransport();
    transport.selectedStatus = "sleeping";
    transport.fleet = [session(SESSION_A, { status: "sleeping", backupId: "backup-1" })];
    const controller = new FleetConsoleController(transport);

    await controller.loadFleet();
    await controller.inspectSession(SESSION_A);

    expect(controller.state.selectedSessionId).toBe(SESSION_A);
    expect(controller.state.cache(SESSION_A).metadata?.status).toBe("sleeping");
    expect(controller.state.cache(SESSION_A).live).toBeUndefined();
    expect(transport.reads).toEqual(["GET /api/sessions", `GET /api/sessions/${SESSION_A}`]);
    expect(transport.commands).toEqual([]);
    controller.stop();
  });

  it("closes and switches sessions without lifecycle, switch, or abort commands", async () => {
    const { controller, transport } = await open();
    controller.state.setDraft(SESSION_A, "draft A");
    controller.state.scroll(SESSION_A, 4);
    controller.state.toggleFold(SESSION_A, "settled-turns");

    controller.closeLocal();
    expect(controller.state.selectedSessionId).toBeUndefined();
    controller.moveFleetCursor(1);
    await controller.openCursor();
    await Promise.resolve();

    expect(transport.commands).toEqual([]);
    expect(transport.remoteLifecycleMutations).toBe(0);
    expect(controller.state.cache(SESSION_A).draft).toBe("draft A");
    expect(controller.state.cache(SESSION_A).scroll).toBe(4);
    expect(controller.state.cache(SESSION_A).folded.has("settled-turns")).toBe(true);
    expect(controller.state.cache(SESSION_B).live?.sessionRevision).toBe(11);
    controller.stop();
  });

  it("backs off, re-snapshots, and reconnects after unexpected SSE EOF", async () => {
    const transport = new FakeConsoleTransport();
    transport.streamMode = "eof_once";
    const attempts: number[] = [];
    const { controller } = await open(transport, async (attempt, signal) => {
      attempts.push(attempt);
      return !signal.aborted;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(attempts).toEqual([0]);
    expect(transport.streamCalls).toBe(2);
    expect(transport.reads.filter((read) => read.endsWith("/snapshot"))).toHaveLength(2);
    expect(controller.state.cache(SESSION_A).error).toBeUndefined();
    controller.stop();
  });

  it("cancels reconnect backoff when switching to fleet", async () => {
    const transport = new FakeConsoleTransport();
    transport.streamMode = "eof";
    let backoffSignal: AbortSignal | undefined;
    const { controller } = await open(
      transport,
      (_attempt, signal) =>
        new Promise((resolve) => {
          backoffSignal = signal;
          signal.addEventListener("abort", () => resolve(false), { once: true });
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.closeLocal();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(backoffSignal?.aborted).toBe(true);
    expect(transport.reads.filter((read) => read.endsWith("/snapshot"))).toHaveLength(1);
  });

  it("binds one stable command ID to the selected epoch and revision", async () => {
    const { controller, transport } = await open();
    controller.state.setDraft(SESSION_A, "hello");
    await controller.submitDraft();

    expect(transport.commands).toEqual([
      {
        version: 1,
        epoch: "epoch-1",
        commandId: COMMAND_ID,
        expectedSessionRevision: 7,
        intent: { type: "prompt", message: "hello" },
      },
    ]);
    expect(controller.state.cache(SESSION_A).draft).toBe("");
    controller.stop();
  });

  it("passes images to every message intent and restores submitted text after rejection", async () => {
    const { controller, transport } = await open();
    await controller.submitText("inspect", false, [IMAGE]);
    const live = controller.state.cache(SESSION_A).live;
    if (live === undefined) throw new Error("missing fixture live state");
    controller.state.cache(SESSION_A).live = { ...live, isStreaming: true };
    await controller.submitText("adjust", false, [IMAGE]);
    await controller.submitText("next", true, [IMAGE]);

    expect(transport.commands.map((entry) => entry.intent)).toEqual([
      { type: "prompt", message: "inspect", images: [IMAGE] },
      { type: "steer", message: "adjust", images: [IMAGE] },
      { type: "follow_up", message: "next", images: [IMAGE] },
    ]);

    transport.commandMode = "rejected";
    controller.state.setDraft(SESSION_A, "  describe this  ");
    await controller.submitDraft(false, [IMAGE]);
    expect(transport.commands.at(-1)?.intent).toEqual({
      type: "steer",
      message: "describe this",
      images: [IMAGE],
    });
    expect(controller.state.cache(SESSION_A).draft).toBe("  describe this  ");
    controller.stop();
  });

  it("does not retry an ambiguous command and passively re-snapshots", async () => {
    const { controller, transport } = await open();
    transport.commandMode = "ambiguous";
    controller.state.setDraft(SESSION_A, "hello");
    const snapshotsBefore = transport.reads.filter((read) => read.endsWith("/snapshot")).length;

    await controller.submitDraft();

    expect(transport.commands).toHaveLength(1);
    expect(transport.reads.filter((read) => read.endsWith("/snapshot"))).toHaveLength(
      snapshotsBefore + 1,
    );
    expect(controller.state.cache(SESSION_A).outcomeUnknownCommandId).toBe(COMMAND_ID);
    expect(controller.state.cache(SESSION_A).draft).toBe("hello");
    controller.stop();
  });

  it("refreshes a stale revision without replaying the command", async () => {
    const { controller, transport } = await open();
    transport.commandMode = "stale";
    controller.state.setDraft(SESSION_A, "hello");

    await controller.submitDraft();

    expect(transport.commands).toHaveLength(1);
    expect(controller.state.cache(SESSION_A).live?.sessionRevision).toBe(8);
    expect(controller.state.cache(SESSION_A).draft).toBe("hello");
    expect(controller.state.cache(SESSION_A).commandStatus).toContain("Submit again");
    controller.stop();
  });

  it("aborts only while active and never clears an idle draft", async () => {
    const { controller, transport } = await open();
    controller.state.setDraft(SESSION_A, "discard me");
    await controller.abortActive();
    expect(controller.state.cache(SESSION_A).draft).toBe("discard me");
    expect(transport.commands).toEqual([]);

    const live = controller.state.cache(SESSION_A).live;
    if (live === undefined) throw new Error("missing fixture live state");
    controller.state.cache(SESSION_A).live = { ...live, isStreaming: true };
    await controller.abortActive();
    expect(transport.commands.map((command) => command.intent)).toEqual([{ type: "abort" }]);
    controller.stop();
  });

  it("keeps a delivered UI response pending and disables duplicates until authority resolves", async () => {
    const { controller, transport } = await open();
    const live = controller.state.cache(SESSION_A).live;
    if (live === undefined) throw new Error("missing fixture live state");
    controller.state.cache(SESSION_A).live = {
      ...live,
      pendingUi: [{ id: "dialog-1", method: "confirm", title: "Continue?", message: "Now" }],
    };

    await controller.answerExtensionUi("dialog-1", { confirmed: false });
    await controller.answerExtensionUi("dialog-1", { confirmed: true });

    expect(transport.commands).toHaveLength(1);
    expect(transport.commands[0]?.intent).toEqual({
      type: "extension_ui_response",
      id: "dialog-1",
      confirmed: false,
    });
    expect(controller.state.cache(SESSION_A).live?.pendingUi).toHaveLength(1);
    expect([...controller.state.cache(SESSION_A).uiAnswers.values()]).toEqual([
      "delivered_unconfirmed",
    ]);
    expect(controller.state.cache(SESSION_A).commandStatus).toContain("awaiting continuation");

    expect(
      controller.state.applyEvent(SESSION_A, {
        epoch: live.epoch,
        sequence: live.sequence + 1,
        event: { type: "extension_ui_closed", id: "dialog-1" },
      }),
    ).toBe("applied");
    expect(controller.state.cache(SESSION_A).live?.pendingUi).toEqual([]);
    expect(controller.state.cache(SESSION_A).uiAnswers.size).toBe(0);
    controller.stop();
  });

  it("keeps deterministic UI rejection retryable", async () => {
    const transport = new FakeConsoleTransport();
    transport.commandMode = "rejected";
    transport.pendingUi = [
      { id: "dialog-1", method: "confirm", title: "Continue?", message: "Now" },
    ];
    const { controller } = await open(transport);
    await controller.answerExtensionUi("dialog-1", { confirmed: true });
    await controller.answerExtensionUi("dialog-1", { confirmed: false });

    expect(transport.commands).toHaveLength(2);
    expect(controller.state.cache(SESSION_A).live?.pendingUi).toHaveLength(1);
    expect(controller.state.cache(SESSION_A).uiAnswers.size).toBe(0);
    controller.stop();
  });

  it("keeps ambiguous UI answers visible and permits stale answers to retry after refresh", async () => {
    const ambiguousTransport = new FakeConsoleTransport();
    ambiguousTransport.commandMode = "ambiguous";
    ambiguousTransport.pendingUi = [
      { id: "dialog-1", method: "confirm", title: "Continue?", message: "Now" },
    ];
    const { controller: ambiguous } = await open(ambiguousTransport);
    await ambiguous.answerExtensionUi("dialog-1", { confirmed: true });
    await ambiguous.answerExtensionUi("dialog-1", { confirmed: true });

    const ambiguousCache = ambiguous.state.cache(SESSION_A);
    expect(ambiguousTransport.commands).toHaveLength(1);
    expect(ambiguousCache.live?.pendingUi).toHaveLength(1);
    expect([...ambiguousCache.uiAnswers.values()]).toEqual(["outcome_unknown"]);
    expect(ambiguousCache.commandStatus).toContain("Outcome unknown");
    ambiguous.stop();

    const staleTransport = new FakeConsoleTransport();
    staleTransport.commandMode = "stale";
    staleTransport.pendingUi = [
      { id: "dialog-2", method: "confirm", title: "Continue?", message: "Now" },
    ];
    const { controller: stale } = await open(staleTransport);
    await stale.answerExtensionUi("dialog-2", { confirmed: true });
    await stale.answerExtensionUi("dialog-2", { confirmed: false });

    expect(staleTransport.commands).toHaveLength(2);
    expect(stale.state.cache(SESSION_A).live?.pendingUi).toHaveLength(1);
    expect(stale.state.cache(SESSION_A).uiAnswers.size).toBe(0);
    stale.stop();
  });

  it("returns select, input, and editor values with strict response shapes", async () => {
    const { controller, transport } = await open();
    const cache = controller.state.cache(SESSION_A);
    const live = cache.live;
    if (live === undefined) throw new Error("missing fixture live state");

    cache.live = {
      ...live,
      pendingUi: [{ id: "select-1", method: "select", title: "Choose", options: ["one"] }],
    };
    await controller.answerExtensionUi("select-1", { value: "one" });
    cache.live = {
      ...cache.live,
      pendingUi: [{ id: "input-1", method: "input", title: "Name", placeholder: "value" }],
    };
    await controller.answerExtensionUi("input-1", { value: "typed" });
    cache.live = {
      ...cache.live,
      pendingUi: [{ id: "editor-1", method: "editor", title: "Edit", prefill: "before" }],
    };
    await controller.answerExtensionUi("editor-1", { value: "after\nline" });

    expect(transport.commands.map((command) => command.intent)).toEqual([
      { type: "extension_ui_response", id: "select-1", value: "one" },
      { type: "extension_ui_response", id: "input-1", value: "typed" },
      { type: "extension_ui_response", id: "editor-1", value: "after\nline" },
    ]);
    controller.stop();
  });

  it("refreshes /sessions locally, consumes it, and reports refresh errors locally", async () => {
    const { controller, transport } = await open();
    controller.state.setDraft(SESSION_A, "/sessions");

    await controller.submitDraft();

    expect(controller.state.sessionsPicker.status).toBe("open");
    expect(controller.state.cache(SESSION_A).draft).toBe("");
    expect(transport.reads.filter((read) => read === "GET /api/sessions")).toHaveLength(2);
    expect(transport.commands).toEqual([]);

    controller.closeSessionsPicker();
    transport.listError = new Error("refresh unavailable");
    controller.state.setDraft(SESSION_A, "/sessions");
    await controller.submitDraft();
    expect(controller.state.sessionsPicker).toMatchObject({
      status: "error",
      message: "pi-scotty failed",
    });
    expect(transport.commands).toEqual([]);
    controller.stop();
  });

  it("guards unavailable picker rows and closes a current-session choice without reconnecting", async () => {
    const { controller, transport } = await open();
    transport.fleet = [session(SESSION_A), session(SESSION_B, { status: "sleeping" })];
    await controller.openSessionsPicker();
    const readsBefore = [...transport.reads];

    await controller.chooseSession(SESSION_B);
    expect(controller.state.selectedSessionId).toBe(SESSION_A);
    expect(controller.state.sessionsPicker).toMatchObject({
      status: "open",
      message: "Only warm Cloudflare sessions can be opened",
    });
    expect(transport.reads).toEqual(readsBefore);

    await controller.chooseSession(SESSION_A);
    expect(controller.state.sessionsPicker.status).toBe("closed");
    expect(transport.reads).toEqual(readsBefore);
    expect(transport.commands).toEqual([]);
    controller.stop();
  });

  it("switches an eligible picker choice through select and preserves cached drafts", async () => {
    const { controller, transport } = await open();
    controller.state.setDraft(SESSION_A, "draft A");
    controller.state.setDraft(SESSION_B, "draft B");
    await controller.openSessionsPicker();

    await controller.chooseSession(SESSION_B);
    await Promise.resolve();

    expect(controller.state.selectedSessionId).toBe(SESSION_B);
    expect(controller.state.sessionsPicker.status).toBe("closed");
    expect(controller.state.cache(SESSION_A).draft).toBe("draft A");
    expect(controller.state.cache(SESSION_B).draft).toBe("draft B");
    expect(transport.reads).toContain(`GET /api/sessions/${SESSION_B}`);
    expect(transport.reads).toContain(`GET /s/${SESSION_B}/console/v1/snapshot`);
    expect(transport.commands).toEqual([]);
    expect(transport.remoteLifecycleMutations).toBe(0);
    controller.stop();
  });

  it("ignores a late picker refresh after close", async () => {
    const { controller, transport } = await open();
    let releaseRefresh: (() => void) | undefined;
    transport.listGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    transport.fleet = [session(SESSION_B)];

    const refresh = controller.openSessionsPicker();
    expect(controller.state.sessionsPicker.status).toBe("loading");
    controller.closeSessionsPicker();
    releaseRefresh?.();
    await refresh;

    expect(controller.state.sessionsPicker.status).toBe("closed");
    expect(controller.state.fleet.map((entry) => entry.id)).toEqual([SESSION_A, SESSION_B]);
    expect(controller.state.selectedSessionId).toBe(SESSION_A);
    controller.stop();
  });

  it("keeps /fold local and never invokes transport", async () => {
    const { controller, transport } = await open();
    controller.state.setDraft(SESSION_A, "/fold");
    await controller.submitDraft();
    expect(controller.state.cache(SESSION_A).folded.has("settled-turns")).toBe(true);
    expect(transport.commands).toEqual([]);
    controller.state.setDraft(SESSION_A, "/fold");
    await controller.submitDraft();
    expect(controller.state.cache(SESSION_A).folded.has("settled-turns")).toBe(false);
    expect(transport.commands).toEqual([]);
    controller.stop();
  });
});
