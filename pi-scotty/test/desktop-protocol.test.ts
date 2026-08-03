import { describe, expect, it } from "vitest";
import { FleetConsoleState } from "../src/state.ts";
import {
  decodeDesktopCommand,
  DESKTOP_MAX_COMMAND_BYTES,
  DESKTOP_MAX_FRAME_BYTES,
  encodeDesktopFrame,
  projectDesktopState,
} from "../src/desktop-protocol.ts";
import { SESSION_A, session, snapshot } from "./fixtures.ts";

describe("desktop protocol", () => {
  it("decodes only bounded, exact command shapes", () => {
    expect(
      decodeDesktopCommand(JSON.stringify({ version: 2, type: "select", sessionId: SESSION_A })),
    ).toEqual({ version: 2, type: "select", sessionId: SESSION_A });
    expect(
      decodeDesktopCommand(
        JSON.stringify({
          version: 2,
          type: "submit",
          sessionId: SESSION_A,
          expectedEpoch: "epoch-1",
          expectedSessionRevision: 7,
          text: "ship",
        }),
      ),
    ).toMatchObject({
      type: "submit",
      sessionId: SESSION_A,
      expectedEpoch: "epoch-1",
      expectedSessionRevision: 7,
    });
    expect(
      decodeDesktopCommand(
        JSON.stringify({
          version: 2,
          type: "create_sandbox",
          requestId: "request-create-0001",
          title: "Review branch",
          prompt: "Review this branch",
          repo: "owner/repo",
          hardCapSeconds: 3600,
        }),
      ),
    ).toMatchObject({ type: "create_sandbox", repo: "owner/repo", hardCapSeconds: 3600 });
    expect(
      decodeDesktopCommand(
        JSON.stringify({
          version: 2,
          type: "create_sandbox",
          requestId: "bad request id",
          title: "Review branch",
          prompt: "Review this branch",
          repo: "not-a-repo",
          hardCapSeconds: 30,
        }),
      ),
    ).toBeUndefined();
    expect(
      decodeDesktopCommand(
        JSON.stringify({ version: 2, type: "submit", sessionId: SESSION_A, text: "ship" }),
      ),
    ).toBeUndefined();
    expect(
      decodeDesktopCommand(
        JSON.stringify({ version: 2, type: "select", sessionId: SESSION_A, credential: "no" }),
      ),
    ).toBeUndefined();
    expect(
      decodeDesktopCommand(JSON.stringify({ version: 1, type: "select", sessionId: SESSION_A })),
    ).toBeUndefined();
    expect(
      decodeDesktopCommand(
        JSON.stringify({
          version: 2,
          type: "create_sandbox",
          requestId: "request-create-escaped",
          title: "Review branch",
          prompt: "\u0000".repeat(16 * 1024),
          repo: "owner/repo",
          hardCapSeconds: 3600,
        }),
      ),
    ).toBeDefined();
    expect(
      decodeDesktopCommand(
        JSON.stringify({
          version: 2,
          type: "create_sandbox",
          requestId: "request-create-oversized",
          title: "Review branch",
          prompt: "x".repeat(60 * 1024 + 1),
          repo: "owner/repo",
          hardCapSeconds: 3600,
        }),
      ),
    ).toBeUndefined();
    expect(decodeDesktopCommand("not json")).toBeUndefined();
    expect(decodeDesktopCommand("x".repeat(DESKTOP_MAX_COMMAND_BYTES + 1))).toBeUndefined();
  });

  it("projects maps and sets into a redacted JSON-safe selected state", () => {
    const state = new FleetConsoleState();
    state.setFleet([
      {
        ...session(SESSION_A),
        title: "github_pat_fleet-secret",
        backupId: "github_pat_backup-secret",
      },
    ]);
    state.selectLocal(SESSION_A);
    state.setMetadata(SESSION_A, session(SESSION_A));
    state.setSnapshot(SESSION_A, {
      ...snapshot(),
      messages: [{ role: "assistant", content: "github_pat_secret-value" }],
      activeTools: [
        { id: "tool-1", name: "read", status: "running", arguments: { path: "/tmp/a" } },
      ],
    });
    state.toggleFold(SESSION_A, "settled-turns");

    const projected = projectDesktopState(state);
    expect(projected.selected).not.toHaveProperty("folded");
    expect(projected.selected).not.toHaveProperty("uiAnswers");
    expect(projected.selected?.draftGeneration).toBe(0);
    expect(projected.fleet[0]?.title).toContain("[credential]");
    expect(projected.fleet[0]?.title).not.toContain("github_pat");
    expect(projected.fleet[0]?.backupId).toBe("[credential]-secret");
    expect(projected.selected?.live?.transcript).toEqual([
      {
        kind: "assistant",
        id: "message-assistant-0-text",
        text: "[credential]-value",
      },
      {
        kind: "tool",
        id: "tool-1",
        name: "read",
        summary: "Read file",
        detail: "/tmp/a",
        status: "running",
        result: null,
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("github_pat_secret-value");
    expect(JSON.stringify(projected)).toContain("[credential]");
    expect(encodeDesktopFrame({ version: 2, type: "state", state: projected })).toMatch(/\n$/u);
    expect(
      encodeDesktopFrame({
        version: 2,
        type: "error",
        code: "command_failed",
        message: "x".repeat(DESKTOP_MAX_FRAME_BYTES),
      }),
    ).toBeUndefined();
  });

  it("keeps oversized transcript projections usable by dropping oldest messages", () => {
    const state = new FleetConsoleState();
    state.setFleet([session(SESSION_A)]);
    state.selectLocal(SESSION_A);
    state.setSnapshot(SESSION_A, snapshot());
    const projected = projectDesktopState(state);
    const selected = projected.selected;
    const live = selected?.live;
    if (selected === undefined || live === undefined)
      throw new Error("expected selected live state");

    const encoded = encodeDesktopFrame({
      version: 2,
      type: "state",
      state: {
        ...projected,
        selected: {
          ...selected,
          live: {
            ...live,
            transcript: Array.from({ length: 1200 }, (_, index) => ({
              kind: "assistant" as const,
              id: `message-${index}`,
              text: `${index}:${"x".repeat(8_000)}`,
            })),
          },
        },
      },
    });
    expect(encoded).toBeDefined();
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(
      DESKTOP_MAX_FRAME_BYTES,
    );
    expect(encoded).toContain('"sidecarTruncated":true');
    expect(encoded).toContain('"1199:');
    expect(encoded).not.toContain('"0:');
  });
});
