import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { CODEX_VERSION } from "../../../../protocol/codex-app-server";
import type {
  CanonicalConversationTool,
  CanonicalConversationTurn,
} from "../../../../protocol/conversation";
import { codexConversation } from "../../../src/agent/codex/conversation";
import { CodexSnapshot } from "../../../src/agent/codex/runtime";

const makeSnapshot = (
  overrides: Partial<typeof CodexSnapshot.Type> = {},
): typeof CodexSnapshot.Type => ({
  generation: "generation-1",
  threadId: "thread-1",
  version: CODEX_VERSION,
  settings: {
    model: "gpt-5.4",
    effort: "high",
    workspace: "/workspace",
    modelProvider: "scotty-managed",
    approvalPolicy: "never",
    sandbox: "dangerFullAccess",
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
  it.effect("surfaces a bounded runtime failure and closes dangling fallback tools", () =>
    Effect.gen(function* () {
      const conversation = yield* codexConversation(makeSnapshot({ tools: [runningTool] }), {
        prompt: "run the command",
        turnId: "failed-turn",
        revision: 4,
      });

      assert.isFalse(conversation.followUpAvailable);
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
      const conversation = yield* codexConversation(makeSnapshot({ turns: [completed, failed] }), {
        prompt: "current prompt",
        turnId: "failed-turn",
        revision: 4,
      });

      assert.deepStrictEqual(conversation.turns[0], completed);
      assert.deepStrictEqual(conversation.turns[1], {
        ...failed,
        activitySummary: "Runtime failure: request_timeout",
        tools: [{ ...runningTool, state: "failed" }],
      });
    }),
  );
  it.effect("allows follow-ups after a terminal failed turn when the runtime is healthy", () =>
    Effect.gen(function* () {
      const conversation = yield* codexConversation(
        makeSnapshot({
          ready: true,
          failure: null,
          prompt: { status: "terminal", turnId: "turn-1", outcome: "failed", text: "Task failed" },
        }),
        { prompt: "try the task", turnId: "turn-1", revision: 4 },
      );
      assert.isTrue(conversation.followUpAvailable);
      assert.equal(conversation.turns[0]?.state, "failed");
    }),
  );
});
