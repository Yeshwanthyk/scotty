import type { ConversationTurn } from "../domain/conversation";

// These fixtures preserve the structural shape of local Pi JSONL sessions while
// deliberately using synthetic copy, paths, identifiers, and tool output.
export const conversationFixture: ReadonlyArray<ConversationTurn> = [
  {
    id: "turn-001",
    state: "completed",
    user: "Map the session states and point out where an operation can become ambiguous.",
    activitySummary:
      "Tracing authority, runtime readiness, and the list projection as separate owners.",
    tools: [
      {
        id: "tool-001",
        label: "Read project",
        invocation: "search lifecycle contracts",
        state: "completed",
        output: "12 relevant definitions across actor, API, and UI boundaries",
      },
      {
        id: "tool-002",
        label: "Check model",
        invocation: "run lifecycle invariants",
        state: "completed",
        output: "All modeled transitions terminate or retain explicit retry ownership",
      },
    ],
    assistant:
      "The session actor is authoritative. Runtime readiness and the rail are projections, so neither may invent lifecycle state. The risky seam is a committed transition whose provider outcome is still unknown; that must remain reconciling until the actor records a terminal result.",
    elapsedSeconds: 38,
  },
  {
    id: "turn-002",
    state: "completed",
    user: "Make the sidebar quieter and keep archived sessions below active sessions.",
    activitySummary:
      "Comparing rail density, repository identity, and native scrolling on narrow screens.",
    tools: [
      {
        id: "tool-003",
        label: "Inspect interface",
        invocation: "capture desktop and mobile rail",
        state: "completed",
        output: "Active and Settled sections verified at 390px and 1280px",
      },
      {
        id: "tool-004",
        label: "Edit files",
        invocation: "update session rail",
        state: "completed",
        output: "Repository labels moved into rows; quiet scrollbar scoped to scrollports",
      },
    ],
    assistant:
      "Active sessions now lead the rail. Older sleeping and failed sessions sit in a compact Settled section beneath them, with repository identity on each row and no persistent scrollbar strip.",
    elapsedSeconds: 24,
  },
  {
    id: "turn-003",
    state: "completed",
    user: "What should happen when I open a sleeping session?",
    tools: [],
    assistant:
      "Open the retained conversation immediately, explain that compute is stopped, and make Resume the clear primary action. Reading history must not require a warm runtime; only continuing the conversation does.",
    elapsedSeconds: 8,
  },
  {
    id: "turn-004",
    state: "completed",
    user: "Check a long conversation with enough content to prove that the transcript remains readable, the rail stays independently scrollable, and completed work does not dominate the page.",
    activitySummary:
      "Reviewing disclosure defaults and keeping chronological tool evidence available.",
    tools: [
      {
        id: "tool-005",
        label: "Test in browser",
        invocation: "run responsive transcript journey",
        state: "completed",
        output: "Scroll anchoring preserved; completed turns remain keyboard-expandable",
      },
    ],
    assistant:
      "The transcript uses one scroll owner and compact completed-turn summaries. Expanding a turn reveals its response and every tool result in chronological order. The current turn remains open, so new text never arrives inside a collapsed region.",
    elapsedSeconds: 17,
  },
  {
    id: "turn-005",
    state: "streaming",
    user: "Now simulate an active implementation pass with streaming text and visible tool progress.",
    activitySummary: "Checking the canonical state contract before composing the next UI slice.",
    tools: [
      {
        id: "tool-006",
        label: "Read project",
        invocation: "inspect conversation event shapes",
        state: "completed",
        output: "user, assistant text, thinking, tool call, and tool result shapes found",
      },
      {
        id: "tool-007",
        label: "Test in browser",
        invocation: "verify streaming and disclosure",
        state: "running",
      },
    ],
    assistant:
      "I’m rendering the current turn as a stable timeline: tool status updates in place, text streams without shifting the whole page, and completed work folds into a concise summary once the turn reaches its terminal event.",
  },
];
