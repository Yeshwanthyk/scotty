import { assert, describe, it } from "@effect/vitest";
import {
  PI_CONSOLE_MAX_COMMAND_BYTES,
  PI_CONSOLE_MAX_IMAGE_BYTES,
  PI_CONSOLE_MAX_IMAGES,
  PI_CONSOLE_MAX_PENDING_UI,
  PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER,
  commandIntentDigest,
  completeSnapshotOverlap,
  createPendingUiTracker,
  createProjectionReducer,
  filterRemoteCommands,
  normalizeCommand,
  normalizeExtensionUiEvent,
  sanitizeRemoteString,
  sanitizeRemoteEvent,
  sanitizeRemoteValue,
  canonicalizePiSubagentsActivity,
  normalizePiSubagentsActivityWidget,
  shouldEmitSseHeartbeat,
} from "../container/scotty-pi-protocol.mjs";

const epoch = "epoch-1";
const commandId = "123e4567-e89b-42d3-a456-426614174000";
const base64ZeroBytes = (decodedBytes) => {
  assert.strictEqual(decodedBytes % 3, 0);
  return "AAAA".repeat(decodedBytes / 3);
};

describe("Scotty Pi supervisor protocol", () => {
  it("requires a complete contiguous snapshot overlap", () => {
    const events = [
      { epoch, sequence: 5, event: { type: "one" } },
      { epoch, sequence: 6, event: { type: "two" } },
    ];
    assert.deepStrictEqual(completeSnapshotOverlap(events, 4, 6), events);
    assert.strictEqual(completeSnapshotOverlap(events.slice(1), 4, 6), undefined);
    assert.strictEqual(completeSnapshotOverlap(events, 4, 7), undefined);
    assert.deepStrictEqual(completeSnapshotOverlap(events, 6, 6), []);
  });

  it("reduces bounded active tools, queue, and serializable extension surfaces", () => {
    const reducer = createProjectionReducer();
    reducer.reduce({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "echo ok" },
    });
    reducer.reduce({ type: "queue_update", steering: ["fix tests"], followUp: ["summarize"] });
    reducer.reduce({
      type: "extension_ui_request",
      method: "setStatus",
      statusKey: "subagents",
      statusText: "2 running",
    });
    reducer.reduce({
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "workflow",
      widgetLines: ["one", "two"],
      widgetPlacement: "aboveEditor",
    });
    reducer.reduce({ type: "extension_ui_request", method: "setTitle", title: "Fleet" });

    assert.deepStrictEqual(reducer.snapshot(), {
      activeTools: [
        {
          id: "tool-1",
          name: "bash",
          status: "running",
          arguments: { command: "echo ok" },
        },
      ],
      queue: {
        steer: [{ id: "steer-0", text: "fix tests" }],
        followUp: [{ id: "follow-up-0", text: "summarize" }],
      },
      extensionSurface: {
        statuses: { subagents: "2 running" },
        widgets: [
          {
            key: "workflow",
            lines: ["one", "two"],
            placement: "aboveEditor",
          },
        ],
        title: "Fleet",
      },
    });
    reducer.reduce({ type: "tool_execution_end", toolCallId: "tool-1" });
    assert.deepStrictEqual(reducer.snapshot().activeTools, []);
    reducer.reduce({
      type: "tool_execution_start",
      toolCallId: "tool-2",
      toolName: "read",
    });
    reducer.reduce({ type: "agent_settled" });
    assert.deepStrictEqual(reducer.snapshot().activeTools, []);
    assert.deepStrictEqual(reducer.snapshot().queue, { steer: [], followUp: [] });
  });

  it("tracks explicit Pi 0.84 UI timeouts and proves clear boundaries", () => {
    const scheduled = [];
    const cancelled = [];
    const expired = [];
    const overflowed = [];
    const tracker = createPendingUiTracker({
      schedule: (callback, delay) => {
        const timer = { callback, delay };
        scheduled.push(timer);
        return timer;
      },
      cancel: (timer) => cancelled.push(timer),
      onExpire: (id) => expired.push(id),
      onOverflow: (id) => overflowed.push(id),
    });
    tracker.track({ id: "dialog-1", method: "select", timeout: 50, title: "Choose" });
    assert.strictEqual(tracker.has("dialog-1"), true);
    tracker.markDelivered("dialog-1");
    assert.strictEqual(tracker.isDelivered("dialog-1"), true);
    assert.strictEqual(scheduled[0].delay, 50);
    scheduled[0].callback();
    assert.strictEqual(tracker.has("dialog-1"), false);
    assert.strictEqual(tracker.isDelivered("dialog-1"), false);
    assert.deepStrictEqual(expired, ["dialog-1"]);

    for (let index = 0; index <= PI_CONSOLE_MAX_PENDING_UI; index += 1)
      tracker.track({ id: `dialog-${index + 2}`, method: "editor" });
    assert.deepStrictEqual(overflowed, ["dialog-2"]);
    tracker.clear();
    assert.deepStrictEqual(tracker.values(), []);
    assert.ok(cancelled.includes(scheduled[0]));
  });

  it("normalizes exact Pi 0.84 extension UI events before replay and drops invalid dialogs", () => {
    assert.deepStrictEqual(
      normalizeExtensionUiEvent({
        type: "extension_ui_request",
        id: "status-1",
        method: "setStatus",
        statusKey: "subagents",
      }),
      {
        type: "extension_ui_request",
        id: "status-1",
        method: "setStatus",
        statusKey: "subagents",
        statusText: null,
      },
    );
    assert.deepStrictEqual(
      normalizeExtensionUiEvent({
        type: "extension_ui_request",
        id: "widget-1",
        method: "setWidget",
        widgetKey: "tasks",
      }),
      {
        type: "extension_ui_request",
        id: "widget-1",
        method: "setWidget",
        widgetKey: "tasks",
        widgetLines: null,
      },
    );
    assert.strictEqual(
      normalizeExtensionUiEvent({
        type: "extension_ui_request",
        id: "select-1",
        method: "select",
        title: "Choose",
        options: Array.from({ length: 101 }, (_, index) => `option-${index}`),
      }),
      undefined,
    );
    assert.strictEqual(
      normalizeExtensionUiEvent({
        type: "extension_ui_request",
        id: "confirm-1",
        method: "confirm",
        title: "Confirm",
      }),
      undefined,
    );
  });

  it("trusts only the exact bounded subagent widget and preserves generic widgets", () => {
    const child = {
      id: "child-1",
      backend: "pi",
      title: "Inspect",
      status: "running",
      prompt: "Read files",
      output: "",
      transcript: [],
      tools: [],
      queued: [],
      startedAt: 1,
      lastActivityAt: 2,
    };
    const snapshot = { version: 1, revision: 1, generatedAt: 2, children: [child] };
    const normalized = normalizePiSubagentsActivityWidget({
      type: "extension_ui_request",
      widgetKey: "pi-subagents/activity/v1",
      widgetLines: [JSON.stringify(snapshot)],
    });
    assert.deepStrictEqual(normalized?.widgetLines, [JSON.stringify(snapshot)]);
    assert.isUndefined(
      normalizePiSubagentsActivityWidget({
        type: "extension_ui_request",
        widgetKey: "pi-subagents/activity/v1",
        widgetLines: [
          JSON.stringify({ ...snapshot, children: [{ ...child, output: "x".repeat(4097) }] }),
        ],
      }),
    );
    assert.deepStrictEqual(
      normalizePiSubagentsActivityWidget({
        widgetKey: "future/widget/v1",
        widgetLines: ["opaque"],
      }),
      { widgetKey: "future/widget/v1", widgetLines: ["opaque"] },
    );
    assert.deepStrictEqual(canonicalizePiSubagentsActivity(snapshot), snapshot);
  });

  it("suppresses only marked passive SSE heartbeats", () => {
    assert.strictEqual(shouldEmitSseHeartbeat({}), true);
    assert.strictEqual(
      shouldEmitSseHeartbeat({ [PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER]: "1" }),
      false,
    );
  });

  it("translates only approved slash intents and rejects legacy browser commands", () => {
    const slash = normalizeCommand(
      {
        version: 1,
        epoch,
        commandId,
        expectedSessionRevision: 7,
        intent: { type: "slash_command", name: "workflows", arguments: "wf_abcdef012345" },
      },
      epoch,
    );
    assert.strictEqual(slash.ok, true);
    assert.deepStrictEqual(slash.command, {
      type: "prompt",
      message: "/workflows wf_abcdef012345",
    });
    assert.deepStrictEqual(
      normalizeCommand(
        {
          version: 1,
          epoch,
          commandId,
          expectedSessionRevision: 7,
          intent: { type: "prompt", message: "/fold" },
        },
        epoch,
      ),
      { ok: false, error: "slash_prompt_requires_intent" },
    );
    assert.deepStrictEqual(
      normalizeCommand(
        {
          version: 1,
          epoch,
          commandId,
          expectedSessionRevision: 7,
          intent: { type: "fold", targetId: "tool-1" },
        },
        epoch,
      ),
      { ok: false, error: "local_intent_only" },
    );
    assert.deepStrictEqual(
      normalizeCommand(
        {
          version: 1,
          epoch,
          commandId,
          expectedSessionRevision: 7,
          intent: { type: "slash_command", name: "subagents", arguments: "active" },
        },
        epoch,
      ),
      { ok: false, error: "invalid_command" },
    );
    assert.deepStrictEqual(
      normalizeCommand(
        {
          version: 1,
          epoch,
          commandId,
          expectedSessionRevision: 7,
          intent: { type: "slash_command", name: "workflows", arguments: "one two" },
        },
        epoch,
      ),
      { ok: false, error: "invalid_command" },
    );
    assert.deepStrictEqual(
      normalizeCommand(
        { commandId: "browser-command", command: { type: "prompt", message: "/help" } },
        epoch,
      ),
      { ok: false, error: "invalid_command" },
    );
    assert.deepStrictEqual(
      normalizeCommand({ version: 1, epoch, commandId, intent: { type: "abort" } }, epoch),
      { ok: false, error: "invalid_command" },
    );
    assert.deepStrictEqual(
      normalizeCommand(
        { version: 2, epoch, commandId, expectedSessionRevision: 7, intent: { type: "abort" } },
        epoch,
      ),
      { ok: false, error: "invalid_command" },
    );
    assert.deepStrictEqual(
      normalizeCommand(
        { version: 1, epoch, commandId, expectedSessionRevision: 7, intent: { type: "prompt" } },
        epoch,
      ),
      { ok: false, error: "invalid_command" },
    );
    assert.deepStrictEqual(
      normalizeCommand(
        {
          version: 1,
          epoch: "epoch-2",
          commandId,
          expectedSessionRevision: 7,
          intent: { type: "abort" },
        },
        epoch,
      ),
      { ok: false, error: "scotty_epoch_changed" },
    );
  });

  it("preserves bounded images and rejects invalid image command shapes", () => {
    const image = { type: "image", data: "AA==", mimeType: "image/png" };
    for (const intent of [
      { type: "prompt", message: "inspect", images: [image] },
      { type: "steer", message: "adjust", images: [image] },
      { type: "follow_up", message: "continue", images: [image] },
    ]) {
      const normalized = normalizeCommand(
        { version: 1, epoch, commandId, expectedSessionRevision: 7, intent },
        epoch,
      );
      assert.strictEqual(normalized.ok, true);
      assert.deepStrictEqual(normalized.command, intent);
    }

    const invalidImages = [
      Array.from({ length: PI_CONSOLE_MAX_IMAGES + 1 }, () => image),
      [{ ...image, data: "" }],
      [{ ...image, data: "not base64" }],
      [{ ...image, mimeType: "image/svg+xml" }],
      [{ ...image, filename: "secret.png" }],
      [{ ...image, path: "/tmp/secret.png" }],
      [
        { ...image, data: base64ZeroBytes(3 * 1024 * 1024) },
        {
          ...image,
          data: base64ZeroBytes(PI_CONSOLE_MAX_IMAGE_BYTES - 3 * 1024 * 1024 + 1),
        },
      ],
    ];
    for (const images of invalidImages)
      assert.deepStrictEqual(
        normalizeCommand(
          {
            version: 1,
            epoch,
            commandId,
            expectedSessionRevision: 7,
            intent: { type: "prompt", message: "invalid", images },
          },
          epoch,
        ),
        { ok: false, error: "invalid_command" },
      );
    assert.deepStrictEqual(
      normalizeCommand(
        {
          version: 1,
          epoch,
          commandId,
          expectedSessionRevision: 7,
          intent: { type: "abort", images: [image] },
        },
        epoch,
      ),
      { ok: false, error: "invalid_command" },
    );
    assert.strictEqual(PI_CONSOLE_MAX_COMMAND_BYTES, 8 * 1024 * 1024);
  });

  it("scopes canonical command digests to exact intent and filters capabilities", async () => {
    assert.strictEqual(
      await commandIntentDigest({ type: "prompt", message: "one" }),
      await commandIntentDigest({ message: "one", type: "prompt" }),
    );
    assert.notStrictEqual(
      await commandIntentDigest({ type: "prompt", message: "one" }),
      await commandIntentDigest({ type: "prompt", message: "two" }),
    );
    assert.notStrictEqual(
      await commandIntentDigest({ type: "prompt", message: "one" }),
      await commandIntentDigest({
        type: "prompt",
        message: "one",
        images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      }),
    );
    assert.deepStrictEqual(
      filterRemoteCommands([
        { name: "subagents", source: "extension", description: "Inspect" },
        { name: "subagents", source: "extension", description: "Duplicate" },
        { name: "workflows", source: "extension" },
        { name: "fold", source: "extension" },
        { name: "subagents", source: "skill" },
      ]),
      [
        { name: "subagents", description: "Inspect", source: "extension" },
        { name: "workflows", source: "extension" },
      ],
    );
  });

  it("strips control sequences, credentials, deep values, and oversized strings", () => {
    const sanitized = sanitizeRemoteValue({
      text: "\u001b]0;owned\u0007\u001b[31mred\u001b[0m scotty-pi-a0b1c2-token_0 scotty-github-session-secret ghp_abcdef",
      deep: {
        one: {
          two: {
            three: {
              four: {
                five: {
                  six: {
                    seven: {
                      eight: { nine: { ten: { eleven: { twelve: { thirteen: "hidden" } } } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    assert.strictEqual(sanitized.truncated, true);
    assert.strictEqual(sanitized.value.text, "red [sentinel] [sentinel] [credential]");
    assert.strictEqual(sanitizeRemoteString("a\u007fb\u0085c\u009fd"), "abcd");

    assert.deepStrictEqual(
      sanitizeRemoteEvent({
        type: "message_update",
        parts: Array.from({ length: 20 }, () => "x".repeat(16 * 1024)),
      }),
      { type: "scotty_event_truncated", originalType: "message_update" },
    );
  });
});
