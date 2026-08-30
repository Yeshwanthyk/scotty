import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  decodePiConsoleCommand,
  decodePiConsoleCommandReceipt,
  decodePiConsoleSnapshot,
  decodePiConsoleStaleCommand,
  decodePiConsoleUnavailable,
  PI_CONSOLE_MAX_COMMAND_BYTES,
  PI_CONSOLE_MAX_EVENTS,
  PI_CONSOLE_MAX_IMAGE_BYTES,
  PI_CONSOLE_MAX_IMAGES,
  PI_CONSOLE_MAX_STATUSES,
  PI_CONSOLE_MAX_STRING_BYTES,
} from "../../../protocol/pi-console";

const command = (intent: unknown) => ({
  epoch: "epoch-1",
  commandId: "123e4567-e89b-42d3-a456-426614174000",
  expectedSessionRevision: 7,
  intent,
});

const snapshot = () =>
  ({
    epoch: "epoch-1",
    sessionRevision: 7,
    baseSequence: 4,
    sequence: 5,
    state: { isStreaming: false },
    messages: [],
    overlapEvents: [{ epoch: "epoch-1", sequence: 5, event: { type: "agent_settled" } }],
    activeTools: [],
    queue: { steer: [], followUp: [] },
    pendingUi: [],
    pendingUiAuthority: {
      status: "partial",
      reason: "pi_0_83_signal_cancellation_unobservable",
    },
    extensionSurface: { statuses: {}, widgets: [] },
    capabilities: {
      models: [],
      thinkingLevels: ["high"],
      commands: [{ name: "subagents", source: "extension" }],
    },
    truncated: { messages: false, values: false },
  }) as const;

const assertDecodeFailure = (effect: Effect.Effect<unknown, unknown>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    assert.isTrue(Result.isFailure(result));
  });

const base64ZeroBytes = (decodedBytes: number): string => {
  assert.strictEqual(decodedBytes % 3, 0);
  return "AAAA".repeat(decodedBytes / 3);
};

describe("Pi console protocol v1", () => {
  it.effect("decodes the bounded versioned snapshot and typed unavailable state", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* decodePiConsoleSnapshot(snapshot()), snapshot());
      const unavailable = {
        status: "unavailable",
        reason: "provider_passive_relay_unavailable",
        retryable: false,
      } as const;
      assert.deepStrictEqual(yield* decodePiConsoleUnavailable(unavailable), unavailable);
      const stale = {
        status: "stale",
        expectedSessionRevision: 7,
        sessionRevision: 8,
        retryable: false,
      } as const;
      assert.deepStrictEqual(yield* decodePiConsoleStaleCommand(stale), stale);
    }),
  );

  it.effect("accepts only explicit remote slash-command intents", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* decodePiConsoleCommand(
          command({
            type: "slash_command",
            name: "workflows",
            arguments: "wf_abcdef012345",
          }),
        ),
        command({
          type: "slash_command",
          name: "workflows",
          arguments: "wf_abcdef012345",
        }),
      );
      yield* assertDecodeFailure(
        decodePiConsoleCommand(command({ type: "slash_command", name: "fold" })),
      );
      yield* assertDecodeFailure(
        decodePiConsoleCommand(
          command({ type: "slash_command", name: "subagents", arguments: "active" }),
        ),
      );
      const steerArguments = JSON.stringify({
        action: "steer",
        childId: "sa-1",
        revision: 7,
        message: "Focus on the failing test",
      });
      assert.deepStrictEqual(
        yield* decodePiConsoleCommand(
          command({ type: "slash_command", name: "subagents", arguments: steerArguments }),
        ),
        command({ type: "slash_command", name: "subagents", arguments: steerArguments }),
      );
      for (const argumentsText of [
        JSON.stringify({ action: "stop", childId: "sa-1", revision: 7, message: "x" }),
      ])
        yield* assertDecodeFailure(
          decodePiConsoleCommand(
            command({ type: "slash_command", name: "subagents", arguments: argumentsText }),
          ),
        );
      yield* assertDecodeFailure(
        decodePiConsoleCommand(
          command({ type: "slash_command", name: "workflows", arguments: "one two" }),
        ),
      );
      const { expectedSessionRevision: _, ...missingRevision } = command({ type: "abort" });
      yield* assertDecodeFailure(decodePiConsoleCommand(missingRevision));
      yield* assertDecodeFailure(
        decodePiConsoleCommand({
          ...command({ type: "abort" }),
          expectedSessionRevision: -1,
        }),
      );
      yield* assertDecodeFailure(
        decodePiConsoleCommand(command({ type: "prompt", message: "/workflows" })),
      );
      yield* assertDecodeFailure(
        decodePiConsoleCommand(command({ type: "fold", targetId: "tool-1", folded: true })),
      );
      yield* assertDecodeFailure(
        decodePiConsoleCommand(
          command({ type: "prompt", message: "🙂".repeat(PI_CONSOLE_MAX_STRING_BYTES / 4 + 1) }),
        ),
      );
    }),
  );

  it.effect("accepts bounded images only on prompt, steer, and follow-up intents", () =>
    Effect.gen(function* () {
      const images = [
        { type: "image", data: "AA==", mimeType: "image/png" },
        { type: "image", data: "AAA=", mimeType: "image/jpeg" },
        { type: "image", data: "AAAA", mimeType: "image/webp" },
        { type: "image", data: "AQID", mimeType: "image/gif" },
      ] as const;
      for (const intent of [
        { type: "prompt", message: "inspect", images },
        { type: "steer", message: "adjust", images: images.slice(0, 1) },
        { type: "follow_up", message: "continue", images: images.slice(1, 2) },
      ] as const) {
        const value = command(intent);
        assert.deepStrictEqual(yield* decodePiConsoleCommand(value), value);
      }

      yield* assertDecodeFailure(
        decodePiConsoleCommand(
          command({
            type: "prompt",
            message: "too many",
            images: Array.from({ length: PI_CONSOLE_MAX_IMAGES + 1 }, () => images[0]),
          }),
        ),
      );
      for (const invalidImage of [
        { type: "image", data: "", mimeType: "image/png" },
        { type: "image", data: "not base64", mimeType: "image/png" },
        { type: "image", data: "AA==", mimeType: "image/svg+xml" },
        { type: "image", data: "AA==", mimeType: "image/png", filename: "secret.png" },
        { type: "image", data: "AA==", mimeType: "image/png", path: "/tmp/secret.png" },
      ])
        yield* assertDecodeFailure(
          decodePiConsoleCommand(
            command({ type: "prompt", message: "invalid", images: [invalidImage] }),
          ),
        );
      yield* assertDecodeFailure(
        decodePiConsoleCommand(command({ type: "abort", images: images.slice(0, 1) })),
      );

      const overTotal = [
        {
          type: "image",
          data: base64ZeroBytes(3 * 1024 * 1024),
          mimeType: "image/png",
        },
        {
          type: "image",
          data: base64ZeroBytes(PI_CONSOLE_MAX_IMAGE_BYTES - 3 * 1024 * 1024 + 1),
          mimeType: "image/jpeg",
        },
      ];
      yield* assertDecodeFailure(
        decodePiConsoleCommand(
          command({ type: "prompt", message: "too large", images: overTotal }),
        ),
      );
      assert.strictEqual(PI_CONSOLE_MAX_COMMAND_BYTES, 8 * 1024 * 1024);
    }),
  );

  it.effect("accepts only Pi 0.84 extension UI response shapes", () =>
    Effect.gen(function* () {
      const response = command({
        type: "extension_ui_response",
        id: "dialog-1",
        confirmed: false,
      });
      assert.deepStrictEqual(yield* decodePiConsoleCommand(response), response);
      yield* assertDecodeFailure(
        decodePiConsoleCommand(
          command({ type: "extension_ui_response", id: "dialog-1", arbitrary: true }),
        ),
      );
    }),
  );

  it.effect(
    "decodes delivered and unconfirmed extension UI receipts without claiming acceptance",
    () =>
      Effect.gen(function* () {
        const receipt = {
          epoch: "epoch-1",
          commandId: "123e4567-e89b-42d3-a456-426614174000",
          commandDigest: "a".repeat(64),
          status: "delivered",
          response: {
            type: "response",
            command: "extension_ui_response",
            delivery: "unconfirmed",
          },
        } as const;
        assert.deepStrictEqual(yield* decodePiConsoleCommandReceipt(receipt), receipt);
      }),
  );

  it.effect("rejects snapshots beyond replay and extension-status bounds", () =>
    Effect.gen(function* () {
      yield* assertDecodeFailure(
        decodePiConsoleSnapshot({
          ...snapshot(),
          overlapEvents: Array.from({ length: PI_CONSOLE_MAX_EVENTS + 1 }, (_, index) => ({
            epoch: "epoch-1",
            sequence: index + 1,
            event: null,
          })),
        }),
      );
      yield* assertDecodeFailure(
        decodePiConsoleSnapshot({
          ...snapshot(),
          extensionSurface: {
            statuses: Object.fromEntries(
              Array.from({ length: PI_CONSOLE_MAX_STATUSES + 1 }, (_, index) => [
                `status-${index}`,
                "active",
              ]),
            ),
            widgets: [],
          },
        }),
      );
    }),
  );
});
