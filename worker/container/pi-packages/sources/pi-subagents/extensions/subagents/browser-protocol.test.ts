import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentSnapshot } from "./src/domain.ts";
import { handleBrowserActivityCommand } from "./index.ts";
import {
  BROWSER_ACTIVITY_LIMITS,
  BROWSER_ACTIVITY_WIDGET_KEY,
  decodeBrowserActivityCommand,
  decodeBrowserActivitySnapshot,
  encodeBrowserActivityCommand,
  encodeBrowserActivitySnapshot,
  encodeBrowserActivityWidget,
  isBrowserActivityCommand,
  isBrowserActivitySnapshot,
  projectBrowserActivity,
  projectBrowserTerminal,
} from "./src/browser-protocol.ts";

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-1",
    backend: "claude",
    owner: "subagents",
    visibility: "standard",
    resultDelivery: "parent",
    title: "Browser fixture",
    prompt: "Inspect the repository",
    cwd: "/private/project",
    status: "running",
    createdAt: 1_000,
    lastActivityAt: 2_000,
    meta: {
      backend: "claude",
      modelLabel: "claude/test",
      sessionFilePath: "/private/session.jsonl",
      nativeSessionId: "native-secret",
    },
    usage: { tokens: 12, contextWindow: 100 },
    transcript: [],
    liveTools: [],
    completedOperations: 0,
    processTelemetry: "unavailable",
    queued: [],
    finalText: "",
    turns: 0,
    ...overrides,
  };
}

test("browser projection is public, bounded, and caps live standard children", () => {
  const running = Array.from({ length: 6 }, (_, index) =>
    snapshot({
      id: `sa-${index + 1}`,
      title: "x".repeat(BROWSER_ACTIVITY_LIMITS.maxTitleLength + 50),
      prompt: "p".repeat(BROWSER_ACTIVITY_LIMITS.maxPromptLength + 50),
      finalText: "o".repeat(BROWSER_ACTIVITY_LIMITS.maxOutputLength + 50),
      transcript: [
        {
          kind: "user",
          text: "t".repeat(
            BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength + 50,
          ),
        },
      ],
      liveTools: [
        {
          toolId: "tool-1",
          name: "bash",
          argsPreview: "a".repeat(
            BROWSER_ACTIVITY_LIMITS.maxToolArgsLength + 50,
          ),
          outputPreview: "r".repeat(
            BROWSER_ACTIVITY_LIMITS.maxToolOutputLength + 50,
          ),
          startedAt: 1_500,
          updatedAt: 2_000,
        },
      ],
    }),
  );
  const privateChild = snapshot({
    id: "sa-private",
    visibility: "private",
    owner: "btw",
  });
  const terminal = snapshot({
    id: "sa-finished",
    status: "error",
    settledAt: 3_000,
    finalText: "partial output",
    errorText: "failed without exposing session details",
  });

  const projected = projectBrowserActivity(
    [...running, privateChild, terminal],
    7,
    terminal,
    4_000,
  );
  assert.equal(projected.version, 1);
  assert.equal(projected.revision, 7);
  assert.equal(projected.generatedAt, 4_000);
  assert.equal(projected.children.length, 4);
  assert.deepEqual(
    projected.children.map((child) => child.id),
    ["sa-1", "sa-2", "sa-3", "sa-4"],
  );
  assert.equal(projected.terminal?.id, "sa-finished");
  assert.equal(projected.terminal?.status, "error");
  assert.ok(
    (projected.children[0]?.prompt.length ?? Infinity) <=
      BROWSER_ACTIVITY_LIMITS.maxPromptLength,
  );
  const firstTranscript = projected.children[0]?.transcript[0];
  assert.equal(firstTranscript?.kind, "user");
  if (firstTranscript?.kind === "user") {
    assert.ok(
      firstTranscript.text.length <=
        BROWSER_ACTIVITY_LIMITS.maxTranscriptTextLength,
    );
  }
  assert.ok(
    (projected.children[0]?.tools[0]?.args?.length ?? Infinity) <=
      BROWSER_ACTIVITY_LIMITS.maxToolArgsLength,
  );

  const encoded = encodeBrowserActivitySnapshot(projected);
  assert.ok(
    Buffer.byteLength(encoded, "utf8") <=
      BROWSER_ACTIVITY_LIMITS.maxSnapshotBytes,
  );
  assert.doesNotMatch(encoded, /sessionFilePath|nativeSessionId|cwd|owner|btw/);
  assert.equal(encoded, JSON.stringify(JSON.parse(encoded)));
  assert.deepEqual(decodeBrowserActivitySnapshot(encoded), JSON.parse(encoded));
  assert.deepEqual(encodeBrowserActivityWidget(projected), [encoded]);
  assert.equal(BROWSER_ACTIVITY_WIDGET_KEY, "pi-subagents/activity/v1");
});

test("browser protocol rejects unsafe or unbounded payload shapes", () => {
  const projected = projectBrowserActivity([snapshot()], 1, undefined, 10_000);
  assert.equal(isBrowserActivitySnapshot(projected), true);

  const unsafe = {
    ...projected,
    children: [{ ...projected.children[0], cwd: "/private/project" }],
  };
  assert.equal(isBrowserActivitySnapshot(unsafe), false);
  assert.equal(
    decodeBrowserActivitySnapshot(JSON.stringify(unsafe)),
    undefined,
  );

  const oversized = {
    ...projected,
    children: [
      {
        ...projected.children[0],
        prompt: "x".repeat(BROWSER_ACTIVITY_LIMITS.maxPromptLength + 1),
      },
    ],
  };
  assert.equal(isBrowserActivitySnapshot(oversized), false);
  assert.equal(decodeBrowserActivitySnapshot("not json"), undefined);
  assert.equal(decodeBrowserActivitySnapshot(["{}", "extra"]), undefined);
});

test("terminal projection carries one bounded final status/output/failure", () => {
  const done = snapshot({
    status: "done",
    settledAt: 5_000,
    finalText: "final answer",
  });
  const terminal = projectBrowserTerminal(done);
  assert.deepEqual(terminal, {
    id: "sa-1",
    title: "Browser fixture",
    status: "done",
    output: "final answer",
    settledAt: 5_000,
  });

  const failed = projectBrowserTerminal(
    snapshot({
      status: "error",
      settledAt: 6_000,
      finalText: "partial",
      errorText: "failure",
    }),
  );
  assert.deepEqual(failed, {
    id: "sa-1",
    title: "Browser fixture",
    status: "error",
    output: "partial",
    failure: "failure",
    settledAt: 6_000,
  });
  assert.equal(projectBrowserTerminal(snapshot()), undefined);
});

test("browser steer command is versioned, bounded, and strict", () => {
  const command = {
    version: 1 as const,
    action: "steer" as const,
    childId: "sa-1",
    revision: 7,
    message: "Check the failing test",
  };
  const encoded = encodeBrowserActivityCommand(command);
  assert.equal(isBrowserActivityCommand(command), true);
  assert.deepEqual(decodeBrowserActivityCommand(encoded), command);
  assert.equal(
    decodeBrowserActivityCommand({ ...command, action: "stop" }),
    undefined,
  );
  assert.equal(
    decodeBrowserActivityCommand({ ...command, message: "   " }),
    undefined,
  );
  assert.equal(
    decodeBrowserActivityCommand({
      ...command,
      message: "x".repeat(BROWSER_ACTIVITY_LIMITS.maxSteerMessageLength + 1),
    }),
    undefined,
  );
  assert.equal(
    decodeBrowserActivityCommand({ ...command, extra: true }),
    undefined,
  );
});

test("browser steer handler accepts only a fresh running standard child", () => {
  const running = snapshot();
  const sent: Array<[string, string]> = [];
  const manager = {
    view: {
      get: (id: string) => (id === running.id ? running : undefined),
      requestSend: (id: string, message: string) => sent.push([id, message]),
    },
  } as unknown as Parameters<typeof handleBrowserActivityCommand>[1]["manager"];
  const command = {
    version: 1 as const,
    action: "steer" as const,
    childId: running.id,
    revision: 7,
    message: "Focus on the failing test",
  };

  handleBrowserActivityCommand(command, { manager, revision: 7 });
  assert.deepEqual(sent, [[running.id, "Focus on the failing test"]]);

  assert.throws(
    () => handleBrowserActivityCommand(command, { manager, revision: 8 }),
    /Stale/,
  );
  assert.throws(
    () =>
      handleBrowserActivityCommand(
        { ...command, childId: "sa-missing" },
        { manager, revision: 7 },
      ),
    /Unknown/,
  );

  const privateChild = snapshot({ id: "sa-private", visibility: "private" });
  const settledChild = snapshot({ id: "sa-done", status: "done" });
  const restrictedManager = {
    view: {
      get: (id: string) =>
        id === privateChild.id
          ? privateChild
          : id === settledChild.id
            ? settledChild
            : undefined,
      requestSend: () => sent.push(["unexpected", "send"]),
    },
  } as unknown as Parameters<typeof handleBrowserActivityCommand>[1]["manager"];
  assert.throws(
    () =>
      handleBrowserActivityCommand(
        { ...command, childId: privateChild.id },
        { manager: restrictedManager, revision: 7 },
      ),
    /Unknown or private/,
  );
  assert.throws(
    () =>
      handleBrowserActivityCommand(
        { ...command, childId: settledChild.id },
        { manager: restrictedManager, revision: 7 },
      ),
    /settled/,
  );
  assert.deepEqual(sent, [[running.id, "Focus on the failing test"]]);
});
