import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { PiConsoleCommandV1, PiConsoleEventEnvelopeV1 } from "../../protocol/pi-console.ts";
import { commandIntentDigest } from "../../protocol/pi-console-shared.mjs";
import { FleetConsoleController } from "../src/controller.ts";
import { FleetConsoleState, SETTLED_TURNS_FOLD_ID } from "../src/state.ts";
import type { CommandResult, ConsoleTransport } from "../src/transport.ts";
import { FleetConsoleComponent, composerKeyRoute, safeTerminalTitle } from "../src/ui.ts";
import { SESSION_A, session, snapshot } from "./fixtures.ts";

class FakeTerminal implements Terminal {
  columns = 120;
  rows = 40;
  kittyProtocolActive = false;
  title = "";

  start(): void {}
  stop(): void {}
  drainInput(): Promise<void> {
    return Promise.resolve();
  }
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(title: string): void {
    this.title = title;
  }
  setProgress(): void {}
}

class UiTransport implements ConsoleTransport {
  readonly commands: PiConsoleCommandV1[] = [];

  readonly listFleet = async () => [session(SESSION_A)];
  readonly getSelected = async () => session(SESSION_A);
  readonly getSnapshot = async () => snapshot();
  readonly streamEvents = async function* (
    _sessionId: string,
    _epoch: string,
    _since: number,
    signal: AbortSignal,
  ): AsyncIterable<PiConsoleEventEnvelopeV1> {
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
    const delivered = command.intent.type === "extension_ui_response";
    return {
      version: 1,
      epoch: command.epoch,
      commandId: command.commandId,
      commandDigest: await commandIntentDigest(command.intent),
      status: delivered ? "delivered" : "accepted",
      response: delivered ? { delivery: "unconfirmed" } : { success: true },
    };
  };
}

const componentFixture = (selected = false) => {
  const terminal = new FakeTerminal();
  const tui = new TUI(terminal, false, "/tmp/pi-scotty-test-state");
  const transport = new UiTransport();
  const state = new FleetConsoleState();
  state.setFleet([session(SESSION_A)]);
  if (selected) {
    state.selectLocal(SESSION_A);
    state.setMetadata(SESSION_A, session(SESSION_A));
    state.setSnapshot(SESSION_A, snapshot());
  }
  const controller = new FleetConsoleController(
    transport,
    state,
    undefined,
    () => "123e4567-e89b-42d3-a456-426614174000",
  );
  let exits = 0;
  const component = new FleetConsoleComponent(tui, controller, () => {
    exits += 1;
  });
  return { component, controller, state, terminal, transport, exits: () => exits };
};

describe("composer key routing", () => {
  it("keeps submit, follow-up, and newline gestures distinct", () => {
    expect(composerKeyRoute("\r")).toBe("submit");
    expect(composerKeyRoute("\u001b\r")).toBe("follow_up");
    expect(composerKeyRoute("\u001b[13;3u")).toBe("follow_up");
    expect(composerKeyRoute("\u001b[13;2u")).toBe("newline");
    expect(composerKeyRoute("x")).toBe("editor");
  });

  it("makes Ctrl+C inert on fleet/idle while q quits only from fleet", () => {
    const fleet = componentFixture();
    fleet.component.handleInput("\u0003");
    expect(fleet.exits()).toBe(0);
    fleet.component.handleInput("q");
    expect(fleet.exits()).toBe(1);

    const selected = componentFixture(true);
    selected.state.setDraft(SESSION_A, "keep me");
    selected.component.handleInput("\u0003");
    expect(selected.state.cache(SESSION_A).draft).toBe("keep me");
    expect(selected.transport.commands).toEqual([]);
  });

  it("uses Ctrl+G for standard dialog cancellation without stealing Esc-to-fleet", async () => {
    const fixture = componentFixture(true);
    const live = fixture.state.cache(SESSION_A).live;
    if (live === undefined) throw new Error("missing live fixture");
    fixture.state.cache(SESSION_A).live = {
      ...live,
      pendingUi: [{ id: "dialog-1", method: "input", title: "Name" }],
    };

    fixture.component.handleInput("\u0007");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.transport.commands[0]?.intent).toEqual({
      type: "extension_ui_response",
      id: "dialog-1",
      cancelled: true,
    });

    fixture.state.cache(SESSION_A).live = {
      ...live,
      pendingUi: [{ id: "dialog-2", method: "confirm", title: "Leave?", message: "Now" }],
    };
    fixture.component.handleInput("\u001b");
    expect(fixture.state.selectedSessionId).toBeUndefined();
  });

  it("routes released select/confirm dialogs while preserving global Esc and Ctrl+G", async () => {
    const fixture = componentFixture(true);
    const live = fixture.state.cache(SESSION_A).live;
    if (live === undefined) throw new Error("missing live fixture");
    fixture.state.cache(SESSION_A).live = {
      ...live,
      pendingUi: [
        {
          id: "select-1",
          method: "select",
          title: "Choose\rwithout row injection",
          options: ["first\noption", "second\toption"],
        },
      ],
    };

    const rendered = fixture.component.render(120).join("\n");
    expect(rendered).toContain("Choose without row injection");
    expect(rendered).toContain("1. first option");
    expect(rendered).toContain("2. second option");
    expect(rendered).not.toContain("\r");
    expect(rendered).toContain("Ctrl+G");
    fixture.component.handleInput("j");
    fixture.component.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.transport.commands[0]?.intent).toEqual({
      type: "extension_ui_response",
      id: "select-1",
      value: "second\toption",
    });
    expect(fixture.component.render(120).join("\n")).toContain("Awaiting Pi continuation");
    fixture.component.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.transport.commands).toHaveLength(1);

    fixture.state.cache(SESSION_A).live = {
      ...live,
      pendingUi: [
        {
          id: "confirm-1",
          method: "confirm",
          title: "Proceed?\rspoof",
          message: "Now\nlater",
        },
      ],
    };
    const confirmRendered = fixture.component.render(120).join("\n");
    expect(confirmRendered).toContain("Proceed? spoof — Now later");
    expect(confirmRendered).not.toContain("\r");
    fixture.component.handleInput("n");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.transport.commands[1]?.intent).toEqual({
      type: "extension_ui_response",
      id: "confirm-1",
      confirmed: false,
    });
  });

  it("renders supported transcript with released message components and generic remote tool cards", () => {
    const fixture = componentFixture(true);
    const cache = fixture.state.cache(SESSION_A);
    const live = cache.live;
    if (live === undefined) throw new Error("missing live fixture");
    cache.live = {
      ...live,
      messages: [
        { role: "user", content: "**hello**" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "checking" },
            { type: "text", text: "Finished." },
            { type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "remote contents" }],
          isError: false,
        },
      ],
    };

    const rendered = fixture.component.render(120).join("\n");
    expect(rendered).toContain("hello");
    expect(rendered).toContain("checking");
    expect(rendered).toContain("Finished.");
    expect(rendered).toContain("README.md");
    expect(rendered).toContain("remote contents");
    expect(rendered).not.toContain('"role":"assistant"');
  });

  it("sanitizes remote fleet projection timestamps before terminal rendering", () => {
    const fixture = componentFixture();
    fixture.state.setFleet([session(SESSION_A, { projectedAt: "2026-08-01\u009b31m forged" })]);

    const rendered = fixture.component.render(120).join("\n");
    expect(rendered).toContain("2026-08-0131m forged");
    expect(rendered).not.toContain("\u009b");
  });

  it("keeps multiline transcript content while normalizing single-line remote chrome", () => {
    const fixture = componentFixture(true);
    const cache = fixture.state.cache(SESSION_A);
    const live = cache.live;
    if (live === undefined) throw new Error("missing live fixture");
    cache.folded.add(SETTLED_TURNS_FOLD_ID);
    cache.live = {
      ...live,
      messages: [
        { role: "user", content: "older" },
        { role: "assistant", content: "latest-visible\nsecond-line" },
      ],
      notifications: [{ id: "notification-1", type: "warning", message: "before\rINJECT" }],
      extensionSurface: {
        statuses: { "status\rspoof": "value\nnext" },
        title: "\u001b]0;bad\u0007 scotty-github-session-secret",
        widgets: [
          { key: "above", lines: ["above\rwidget"], placement: "aboveEditor" },
          { key: "below", lines: ["below\nwidget"], placement: "belowEditor" },
        ],
      },
    };

    const rendered = fixture.component.render(120).join("\n");
    expect(rendered).toContain("1 older settled transcript entries folded");
    expect(rendered).toContain("latest-visible");
    expect(rendered).toContain("second-line");
    expect(rendered).toContain("warning: before INJECT");
    expect(rendered).toContain("status spoof: value next");
    expect(rendered.indexOf("above widget")).toBeLessThan(rendered.indexOf("PROMPT"));
    expect(rendered.indexOf("below widget")).toBeGreaterThan(rendered.indexOf("PROMPT"));
    expect(rendered).not.toContain("\r");
    expect(fixture.terminal.title).toBe("pi-scotty — [sentinel]");
    expect(fixture.terminal.title).not.toContain("\u001b");
    expect(safeTerminalTitle("line\nnext")).toBe("pi-scotty — line next");
  });
});
