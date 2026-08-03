import { describe, expect, it } from "vitest";
import { FleetConsoleState, hydrateSnapshot } from "../src/state.ts";
import { SESSION_A, event, snapshot } from "./fixtures.ts";

describe("snapshot and SSE reducer", () => {
  it("redacts every snapshot surface before it enters renderable state", () => {
    const leaked = "scotty-pi-a0b1c2d3e4f5-secret_0";
    const github = "scotty-github-a0b1c2d3e4f5-secret";
    const live = hydrateSnapshot({
      ...snapshot(),
      state: { label: leaked },
      messages: [{ role: "assistant", content: github }],
      activeTools: [
        {
          id: "tool-1",
          name: leaked,
          status: "running",
          arguments: { token: github },
        },
      ],
      queue: {
        steer: [{ id: "steer-1", text: leaked }],
        followUp: [{ id: "follow-1", text: github }],
      },
      pendingUi: [
        {
          id: "dialog-1",
          method: "select",
          title: leaked,
          options: [github],
        },
      ],
      extensionSurface: {
        statuses: { auth: leaked },
        widgets: [{ key: "widget", lines: [github], placement: "belowEditor" }],
        title: leaked,
      },
      capabilities: {
        models: [{ provider: leaked, id: github, name: leaked }],
        thinkingLevels: [github],
        commands: [{ name: "workflows", description: leaked, source: "extension" }],
      },
    });

    const renderedState = JSON.stringify({
      state: live.state,
      messages: live.messages,
      tools: [...live.activeTools.values()],
      queue: live.queue,
      pendingUi: live.pendingUi,
      extensionSurface: live.extensionSurface,
      capabilities: live.capabilities,
    });
    expect(renderedState).not.toContain("scotty-pi-");
    expect(renderedState).not.toContain("scotty-github-");
    expect(renderedState.match(/\[sentinel\]/gu)?.length).toBeGreaterThan(8);
  });

  it("keeps every bounded snapshot message independent of its array index", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: "assistant",
      content: `message-${index}`,
    }));
    const live = hydrateSnapshot({ ...snapshot(), messages });

    expect(live.messages).toHaveLength(20);
    expect(live.messages.at(13)).toEqual({ role: "assistant", content: "message-13" });
    expect(live.messages.at(-1)).toEqual({ role: "assistant", content: "message-19" });
  });

  it("hydrates a contiguous overlap, redacts it, and ignores duplicates", () => {
    const overlap = [
      event(1, {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash\u001b[31m",
        args: { token: "scotty-github-session-secret" },
      }),
      event(2, {
        type: "message_end",
        message: { role: "assistant", content: "github_pat_secret-value" },
      }),
    ];
    const state = new FleetConsoleState();
    state.selectLocal(SESSION_A);
    state.setSnapshot(SESSION_A, snapshot(9, overlap));

    expect(state.cache(SESSION_A).live?.sequence).toBe(2);
    expect(state.cache(SESSION_A).live?.activeTools.get("tool-1")?.name).toBe("bash");
    expect(JSON.stringify(state.cache(SESSION_A).live?.activeTools.get("tool-1"))).toContain(
      "[sentinel]",
    );
    expect(JSON.stringify(state.cache(SESSION_A).live?.messages)).toContain("[credential]");
    expect(state.applyEvent(SESSION_A, overlap[1])).toBe("duplicate");
  });

  it("deduplicates snapshot overlap and safely replaces streaming message lifecycle state", () => {
    const user = { role: "user", content: "hello" };
    const overlap = [
      event(1, { type: "message_start", message: user }),
      event(2, { type: "message_end", message: user }),
    ];
    const state = new FleetConsoleState();
    state.selectLocal(SESSION_A);
    state.setSnapshot(SESSION_A, { ...snapshot(7, overlap), messages: [user] });
    expect(state.cache(SESSION_A).live?.messages).toEqual([user]);

    state.applyEvent(
      SESSION_A,
      event(3, {
        type: "message_start",
        message: { role: "assistant", content: [], timestamp: 1 },
      }),
    );
    state.applyEvent(
      SESSION_A,
      event(4, {
        type: "message_update",
        message: { role: "assistant", content: "partial", timestamp: 1 },
      }),
    );
    state.applyEvent(
      SESSION_A,
      event(5, {
        type: "message_end",
        message: { role: "assistant", content: "complete", timestamp: 1 },
      }),
    );

    expect(state.cache(SESSION_A).live?.messages).toEqual([
      user,
      { role: "assistant", content: "complete", timestamp: 1 },
    ]);
  });

  it("reduces queue updates and clears volatile UI on settlement and expiry", () => {
    const state = new FleetConsoleState();
    state.selectLocal(SESSION_A);
    state.setSnapshot(SESSION_A, snapshot());
    state.applyEvent(
      SESSION_A,
      event(1, {
        type: "extension_ui_request",
        id: "dialog-1",
        method: "input",
        title: "Name",
      }),
    );
    state.applyEvent(
      SESSION_A,
      event(2, { type: "queue_update", steering: ["fix"], followUp: ["report"] }),
    );
    expect(state.cache(SESSION_A).live?.queue).toEqual({
      steer: [{ id: "steer-0", text: "fix" }],
      followUp: [{ id: "follow-up-0", text: "report" }],
    });
    state.applyEvent(SESSION_A, event(3, { type: "scotty_extension_ui_expired", id: "dialog-1" }));
    expect(state.cache(SESSION_A).live?.pendingUi).toEqual([]);
    state.applyEvent(SESSION_A, event(4, { type: "agent_settled" }));
    expect(state.cache(SESSION_A).live?.queue).toEqual({ steer: [], followUp: [] });
  });

  it("requires a fresh snapshot on sequence gaps and epoch changes", () => {
    const state = new FleetConsoleState();
    state.selectLocal(SESSION_A);
    state.setSnapshot(SESSION_A, snapshot());

    expect(state.applyEvent(SESSION_A, event(2))).toBe("resnapshot");
    expect(state.applyEvent(SESSION_A, event(1, { type: "agent_start" }, "epoch-2"))).toBe(
      "resnapshot",
    );
    expect(state.cache(SESSION_A).live?.sequence).toBe(0);
  });

  it("reduces blocking dialogs and fire-and-forget extension UI", () => {
    const state = new FleetConsoleState();
    state.selectLocal(SESSION_A);
    state.setSnapshot(SESSION_A, snapshot());

    expect(
      state.applyEvent(
        SESSION_A,
        event(1, {
          type: "extension_ui_request",
          id: "dialog-1",
          method: "select",
          title: "Choose",
          options: ["one", "two"],
        }),
      ),
    ).toBe("applied");
    state.applyEvent(
      SESSION_A,
      event(2, {
        type: "extension_ui_request",
        id: "notice-1",
        method: "notify",
        message: "started",
        notifyType: "info",
      }),
    );
    state.applyEvent(
      SESSION_A,
      event(3, {
        type: "extension_ui_request",
        id: "status-1",
        method: "setStatus",
        statusKey: "subagents",
        statusText: "2 running",
      }),
    );
    state.applyEvent(
      SESSION_A,
      event(4, {
        type: "extension_ui_request",
        id: "widget-1",
        method: "setWidget",
        widgetKey: "tasks",
        widgetLines: ["one active"],
        widgetPlacement: "aboveEditor",
      }),
    );
    state.applyEvent(
      SESSION_A,
      event(5, {
        type: "extension_ui_request",
        id: "title-1",
        method: "setTitle",
        title: "Remote title",
      }),
    );
    state.applyEvent(
      SESSION_A,
      event(6, {
        type: "extension_ui_request",
        id: "editor-1",
        method: "set_editor_text",
        text: "prefilled",
      }),
    );

    const live = state.cache(SESSION_A).live;
    expect(live?.pendingUi).toEqual([
      { id: "dialog-1", method: "select", title: "Choose", options: ["one", "two"] },
    ]);
    expect(live?.notifications).toEqual([{ id: "notice-1", message: "started", type: "info" }]);
    expect(live?.extensionSurface).toEqual({
      statuses: { subagents: "2 running" },
      widgets: [{ key: "tasks", lines: ["one active"], placement: "aboveEditor" }],
      title: "Remote title",
    });
    expect(state.cache(SESSION_A).draft).toBe("prefilled");

    state.applyEvent(
      SESSION_A,
      event(7, {
        type: "extension_ui_request",
        id: "status-clear-1",
        method: "setStatus",
        statusKey: "subagents",
      }),
    );
    state.applyEvent(
      SESSION_A,
      event(8, {
        type: "extension_ui_request",
        id: "widget-clear-1",
        method: "setWidget",
        widgetKey: "tasks",
      }),
    );
    expect(state.cache(SESSION_A).live?.extensionSurface).toEqual({
      statuses: {},
      widgets: [],
      title: "Remote title",
    });
  });

  it("rejects incomplete snapshot overlap", () => {
    const invalid = { ...snapshot(7, [event(1)]), sequence: 2 };
    expect(() => hydrateSnapshot(invalid)).toThrow("overlap was not contiguous");
  });
});
