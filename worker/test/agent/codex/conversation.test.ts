import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { CODEX_VERSION } from "../../../../protocol/agents/codex/codex-app-server";
import type {
  CanonicalConversationTool,
  CanonicalConversationTurn,
} from "../../../../protocol/session/conversation";
import { sidecarConversation } from "../../../src/agent/sidecar/conversation";
import { SidecarSnapshot } from "../../../src/agent/sidecar/protocol";

const makeSnapshot = (
  overrides: Partial<typeof SidecarSnapshot.Type> = {},
): typeof SidecarSnapshot.Type => ({
  agent: "codex",
  generation: "generation-1",
  threadId: "thread-1",
  version: CODEX_VERSION,
  settings: {
    model: "gpt-5.4",
    effort: "high",
    workspace: "/workspace",
  },
  ready: false,
  failure: "request_timeout",
  prompt: { status: "failed", turnId: "failed-turn" },
  cleanup: null,
  ...overrides,
});

const runningTool: CanonicalConversationTool = {
  id: "tool-running",
  state: "running",
  label: "Command",
  invocation: "sleep 10",
};

describe("Codex conversation failure projection", () => {
  it.effect("projects only bounded stale notification context", () =>
    Effect.gen(function* () {
      const conversation = yield* sidecarConversation(
        makeSnapshot({
          failure: "stale_notification",
          failureDiagnostic: "item/started parent completed subAgentActivity",
        }),
        { prompt: "research", turnId: "failed-turn", revision: 1 },
      );
      assert.equal(
        conversation.turns[0]?.activitySummary,
        "Runtime failure: stale_notification (item/started parent completed subAgentActivity)",
      );
      assert.isFalse(conversation.followUpAvailable);
      assert.deepEqual(conversation.runtimeFailure, {
        code: "stale_notification",
        diagnostic: "item/started parent completed subAgentActivity",
      });
    }),
  );

  it.effect("surfaces a bounded runtime failure and closes dangling fallback tools", () =>
    Effect.gen(function* () {
      const conversation = yield* sidecarConversation(makeSnapshot({ tools: [runningTool] }), {
        prompt: "run the command",
        turnId: "failed-turn",
        revision: 4,
      });

      assert.isFalse(conversation.followUpAvailable);
      assert.isTrue(conversation.runtimeStopped);
      assert.deepStrictEqual(conversation.turns, [
        {
          id: "failed-turn",
          state: "failed",
          user: "run the command",
          assistant: "",
          activitySummary: "Runtime failure: request_timeout",
          tools: [{ ...runningTool, state: "failed" }],
        },
      ]);
    }),
  );

  it.effect("preserves completed history while projecting the failed turn", () =>
    Effect.gen(function* () {
      const completed: CanonicalConversationTurn = {
        id: "completed-turn",
        state: "completed",
        user: "previous prompt",
        assistant: "previous answer",
        tools: [
          {
            id: "tool-completed",
            state: "completed",
            label: "Command",
            invocation: "pwd",
            output: "/workspace\n",
          },
        ],
      };
      const failed: CanonicalConversationTurn = {
        id: "failed-turn",
        state: "failed",
        user: "current prompt",
        assistant: "",
        tools: [runningTool],
      };
      const conversation = yield* sidecarConversation(
        makeSnapshot({ turns: [completed, failed] }),
        {
          prompt: "current prompt",
          turnId: "failed-turn",
          revision: 4,
        },
      );

      assert.deepStrictEqual(conversation.turns[0], completed);
      assert.deepStrictEqual(conversation.turns[1], {
        ...failed,
        activitySummary: "Runtime failure: request_timeout",
        tools: [{ ...runningTool, state: "failed" }],
      });
    }),
  );
  it.effect("keeps a saved failed turn visible after the native runtime resumes", () =>
    Effect.gen(function* () {
      const conversation = yield* sidecarConversation(
        makeSnapshot({
          ready: true,
          failure: null,
          turns: [
            {
              id: "failed-turn",
              state: "failed",
              user: "previous task",
              assistant: "",
              tools: [],
            },
          ],
        }),
        { prompt: "previous task", turnId: "failed-turn", revision: 5 },
      );
      assert.isFalse(conversation.runtimeStopped);
      assert.isTrue(conversation.followUpAvailable);
      assert.equal(conversation.turns[0]?.state, "failed");
    }),
  );
  it.effect("reports a stopped runtime without rewriting a completed turn", () =>
    Effect.gen(function* () {
      const conversation = yield* sidecarConversation(
        makeSnapshot({
          failure: "unexpected_exit",
          prompt: { status: "terminal", turnId: "turn-1", outcome: "completed", text: "Done" },
        }),
        { prompt: "task", turnId: "turn-1", revision: 4 },
      );
      assert.isTrue(conversation.runtimeStopped);
      assert.isFalse(conversation.followUpAvailable);
      assert.equal(conversation.turns[0]?.state, "completed");
    }),
  );
});
