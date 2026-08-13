import type { PiConsoleEventEnvelopeV1, PiConsoleSnapshotV1 } from "../../protocol/pi-console.ts";
import type { FleetSession, SelectedSession } from "../src/schemas.ts";

export const SESSION_A = "a0b1c2d3e4f5";
export const SESSION_B = "b0c1d2e3f4a5";

export const session = (id: string, overrides: Partial<FleetSession> = {}): SelectedSession => ({
  version: 1,
  id,
  title: `Session ${id}`,
  status: "warm",
  provider: "cloudflare",
  repo: "owner/repo",
  defaultBranch: "main",
  branch: `scotty/${id}`,
  agentState: "working",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:01:00.000Z",
  hardCapAt: "2026-08-01T04:00:00.000Z",
  projectedAt: "2026-08-01T00:01:00.000Z",
  ageSeconds: 60,
  capRemainingSeconds: 14_340,
  ...overrides,
});

export const event = (
  sequence: number,
  value: PiConsoleEventEnvelopeV1["event"] = {
    type: "message_end",
    message: { role: "assistant", content: "done" },
  },
  epoch = "epoch-1",
): PiConsoleEventEnvelopeV1 => ({ epoch, sequence, event: value });

export const snapshot = (
  sessionRevision = 7,
  overlapEvents: ReadonlyArray<PiConsoleEventEnvelopeV1> = [],
): PiConsoleSnapshotV1 => ({
  version: 1,
  epoch: "epoch-1",
  baseSequence: 0,
  sequence: overlapEvents.length,
  sessionRevision,
  state: { isStreaming: false },
  messages: [{ role: "user", content: "hello" }],
  overlapEvents,
  activeTools: [],
  queue: { steer: [], followUp: [] },
  pendingUi: [],
  pendingUiAuthority: {
    status: "partial",
    reason: "pi_0_83_signal_cancellation_unobservable",
  },
  extensionSurface: { statuses: {}, widgets: [] },
  capabilities: { models: [], thinkingLevels: [], commands: [] },
  truncated: { messages: false, values: false },
});
