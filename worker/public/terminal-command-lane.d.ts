import type {
  ConsoleCommandEnvelope,
  ConsoleCommandResponseBody,
  ConsoleCommandTransportResult,
} from "./terminal-console-client.js";
import type { PiConsoleCommandReceiptV1, PiConsoleRemoteIntentV1 } from "../../protocol/pi-console";

export type CommandOutcome =
  | { readonly status: "accepted"; readonly receipt: PiConsoleCommandReceiptV1 }
  | {
      readonly status: "rejected";
      readonly receipt?: PiConsoleCommandReceiptV1;
      readonly response?: ConsoleCommandResponseBody;
      readonly message: string;
    }
  | { readonly status: "stale"; readonly response: ConsoleCommandResponseBody }
  | {
      readonly status: "ambiguous";
      readonly response?: ConsoleCommandResponseBody;
      readonly message: string;
    }
  | { readonly status: "discarded"; readonly accepted: false; readonly message: string };

export type CommandLaneItem = {
  readonly sessionId: string;
  readonly envelope: ConsoleCommandEnvelope;
  readonly label: string;
  readonly state: "queued" | "sending" | "paused" | CommandOutcome["status"];
  readonly outcome?: CommandOutcome;
};

export function createCommandLane(options: {
  readonly send: (
    sessionId: string,
    envelope: ConsoleCommandEnvelope,
  ) => Promise<ConsoleCommandTransportResult>;
  readonly randomUUID: () => string;
  readonly onChange?: (items: readonly CommandLaneItem[]) => void;
}): {
  readonly enqueue: (command: {
    readonly sessionId: string;
    readonly epoch: string;
    readonly expectedSessionRevision: number;
    readonly intent: PiConsoleRemoteIntentV1;
    readonly label: string;
  }) => { readonly commandId: string; readonly outcome: Promise<CommandOutcome> };
  readonly discard: (sessionId: string) => { readonly discardedCount: number };
  readonly state: (sessionId: string) => {
    readonly paused: "stale" | "ambiguous" | undefined;
    readonly items: readonly CommandLaneItem[];
  };
};

export function classifyCommandResult(
  result: ConsoleCommandTransportResult,
  envelope: ConsoleCommandEnvelope,
): Promise<CommandOutcome>;
