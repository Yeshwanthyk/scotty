import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  decodePiConsoleCommandV1,
  decodePiConsoleCommandReceiptV1,
  decodePiConsoleSnapshotV1,
  decodePiConsoleStaleCommandV1,
  CREDENTIAL_SENTINEL_PREFIXES,
  decodePiConsoleUnavailableV1,
  PI_CONSOLE_MAX_COMMAND_BYTES,
  PI_CONSOLE_MAX_EVENTS,
  PI_CONSOLE_MAX_IMAGE_BYTES,
  PI_CONSOLE_MAX_IMAGES,
  PI_CONSOLE_MAX_STATUSES,
  PI_CONSOLE_MAX_STRING_BYTES,
} from "../../protocol/pi-console";
import { PI_SENTINEL_PREFIX } from "../src/egress";

const command = (intent: unknown) => ({
  version: 1,
  epoch: "epoch-1",
  commandId: "123e4567-e89b-42d3-a456-426614174000",
  expectedSessionRevision: 7,
  intent,
});

const snapshot = () =>
  ({
    version: 1 as const,
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
      assert.deepStrictEqual(yield* decodePiConsoleSnapshotV1(snapshot()), snapshot());
      const unavailable = {
        version: 1,
        status: "unavailable",
        reason: "provider_passive_relay_unavailable",
        retryable: false,
      } as const;
      assert.deepStrictEqual(yield* decodePiConsoleUnavailableV1(unavailable), unavailable);
      const stale = {
        version: 1,
        status: "stale",
        expectedSessionRevision: 7,
        sessionRevision: 8,
        retryable: false,
      } as const;
      assert.deepStrictEqual(yield* decodePiConsoleStaleCommandV1(stale), stale);
    }),
  );

  it.effect("accepts only explicit remote slash-command intents", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* decodePiConsoleCommandV1(
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
        decodePiConsoleCommandV1(command({ type: "slash_command", name: "fold" })),
      );
      yield* assertDecodeFailure(
        decodePiConsoleCommandV1(
          command({ type: "slash_command", name: "subagents", arguments: "active" }),
        ),
      );
      const steerArguments = JSON.stringify({
        version: 1,
        action: "steer",
        childId: "sa-1",
        revision: 7,
        message: "Focus on the failing test",
      });
      assert.deepStrictEqual(
        yield* decodePiConsoleCommandV1(
          command({ type: "slash_command", name: "subagents", arguments: steerArguments }),
        ),
        command({ type: "slash_command", name: "subagents", arguments: steerArguments }),
      );
      for (const argumentsText of [
        JSON.stringify({ version: 1, action: "stop", childId: "sa-1", revision: 7, message: "x" }),
      ])
        yield* assertDecodeFailure(
          decodePiConsoleCommandV1(
            command({ type: "slash_command", name: "subagents", arguments: argumentsText }),
          ),
        );
      yield* assertDecodeFailure(
        decodePiConsoleCommandV1(
          command({ type: "slash_command", name: "workflows", arguments: "one two" }),
        ),
      );
      const { expectedSessionRevision: _, ...missingRevision } = command({ type: "abort" });
      yield* assertDecodeFailure(decodePiConsoleCommandV1(missingRevision));
      yield* assertDecodeFailure(
        decodePiConsoleCommandV1({
          ...command({ type: "abort" }),
          expectedSessionRevision: -1,
        }),
      );
      yield* assertDecodeFailure(
        decodePiConsoleCommandV1(command({ type: "prompt", message: "/workflows" })),
      );
      yield* assertDecodeFailure(
        decodePiConsoleCommandV1(command({ type: "fold", targetId: "tool-1", folded: true })),
      );
      yield* assertDecodeFailure(
        decodePiConsoleCommandV1(
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
        assert.deepStrictEqual(yield* decodePiConsoleCommandV1(value), value);
      }

      yield* assertDecodeFailure(
        decodePiConsoleCommandV1(
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
          decodePiConsoleCommandV1(
            command({ type: "prompt", message: "invalid", images: [invalidImage] }),
          ),
        );
      yield* assertDecodeFailure(
        decodePiConsoleCommandV1(command({ type: "abort", images: images.slice(0, 1) })),
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
        decodePiConsoleCommandV1(
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
      assert.deepStrictEqual(yield* decodePiConsoleCommandV1(response), response);
      yield* assertDecodeFailure(
        decodePiConsoleCommandV1(
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
          version: 1,
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
        assert.deepStrictEqual(yield* decodePiConsoleCommandReceiptV1(receipt), receipt);
      }),
  );

  it.effect("rejects snapshots beyond replay and extension-status bounds", () =>
    Effect.gen(function* () {
      yield* assertDecodeFailure(
        decodePiConsoleSnapshotV1({
          ...snapshot(),
          overlapEvents: Array.from({ length: PI_CONSOLE_MAX_EVENTS + 1 }, (_, index) => ({
            epoch: "epoch-1",
            sequence: index + 1,
            event: null,
          })),
        }),
      );
      yield* assertDecodeFailure(
        decodePiConsoleSnapshotV1({
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

  it("uses the credential authority's exact sentinel prefixes", () => {
    assert.deepStrictEqual(CREDENTIAL_SENTINEL_PREFIXES, ["scotty-pi-", "scotty-env-"]);
    assert.strictEqual(PI_SENTINEL_PREFIX, CREDENTIAL_SENTINEL_PREFIXES[0]);
  });
});
