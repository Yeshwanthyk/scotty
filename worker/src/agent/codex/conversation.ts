import { Effect } from "effect";
import {
  decodeCanonicalConversationSnapshot,
  type CanonicalConversationTurn,
} from "../../../../protocol/conversation";
import type { CodexSnapshot } from "./runtime";

type CodexPromptState = (typeof CodexSnapshot.Type)["prompt"];

const projectFailedTurn = (
  turn: CanonicalConversationTurn,
  state: CanonicalConversationTurn["state"],
  prompt: CodexPromptState,
  fallbackId: string,
  activitySummary: string | undefined,
): CanonicalConversationTurn => {
  const failedId =
    state === "failed" && "turnId" in prompt && prompt.turnId !== null ? prompt.turnId : fallbackId;
  if (state !== "failed" || turn.id !== failedId || turn.state !== "failed") return turn;
  return {
    ...turn,
    ...(activitySummary === undefined ? {} : { activitySummary }),
    tools: turn.tools.map((tool) =>
      tool.state === "running" ? { ...tool, state: "failed" as const } : tool,
    ),
  };
};

const runtimeFailureSummary = (snapshot: typeof CodexSnapshot.Type) =>
  snapshot.failure === null
    ? undefined
    : `Runtime failure: ${snapshot.failure}${snapshot.failureDiagnostic === undefined ? "" : ` (${snapshot.failureDiagnostic})`}`;

export const codexConversation = Effect.fnUntraced(function* (
  snapshot: typeof CodexSnapshot.Type,
  input: {
    readonly prompt: string;
    readonly turnId: string;
    readonly revision: number;
    readonly followUpBlocked?: boolean;
    readonly followUp?: ReadonlyArray<{ readonly id: string; readonly text: string }>;
    readonly messageAdmissionAvailable?: boolean;
  },
) {
  const prompt = snapshot.prompt;
  const user = input.prompt;
  const text = prompt.status === "terminal" ? prompt.text : "";
  const assistant = text;
  const terminal = prompt.status === "terminal";
  const state = terminal
    ? prompt.outcome === "interrupted"
      ? "aborted"
      : prompt.outcome
    : prompt.status === "failed" || snapshot.failure !== null
      ? "failed"
      : "streaming";
  const activitySummary = state === "failed" ? runtimeFailureSummary(snapshot) : undefined;
  const fallbackTurn: CanonicalConversationTurn = {
    id: input.turnId,
    state,
    user,
    assistant,
    tools: snapshot.tools ?? [],
  };
  const turns =
    snapshot.turns === undefined || snapshot.turns.length === 0
      ? [projectFailedTurn(fallbackTurn, state, prompt, input.turnId, activitySummary)]
      : snapshot.turns.map((turn) =>
          projectFailedTurn(turn, state, prompt, input.turnId, activitySummary),
        );
  return yield* decodeCanonicalConversationSnapshot({
    version: 1,
    runtimeStopped: !snapshot.ready,
    ...(snapshot.failure === null
      ? {}
      : {
          runtimeFailure: {
            code: snapshot.failure,
            ...(snapshot.failureDiagnostic === undefined
              ? {}
              : { diagnostic: snapshot.failureDiagnostic }),
          },
        }),
    followUpAvailable: snapshot.ready,
    followUpBlocked: input.followUpBlocked ?? false,
    messageAdmissionAvailable: input.messageAdmissionAvailable ?? true,
    transport: {
      epoch: snapshot.generation,
      baseSequence: 0,
      sequence: snapshot.sequence ?? (terminal || state === "failed" ? 2 : 1),
      sessionRevision: input.revision,
    },
    turns,
    queue: { steer: [], followUp: input.followUp ?? [] },
    truncated: {
      turns: snapshot.turnsTruncated === true,
      values: snapshot.toolsTruncated === true || user !== input.prompt || assistant !== text,
    },
  });
});
