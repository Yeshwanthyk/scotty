import type * as cf from "@cloudflare/workers-types";
import { Schema } from "effect";
import type { Effect } from "effect";

export const PlaceKind = Schema.Literals(["cloudflare"]);

export class ContainerStartFailed extends Schema.TaggedError<ContainerStartFailed>()(
  "ContainerStartFailed",
  {},
) {}

/** Plain HTTP and WebSocket to one port; all any place can honestly offer. */
export interface Port {
  readonly fetch: (input: string, init?: cf.RequestInit) => Promise<cf.Response>;
}

/**
 * Where one session's container runs. The Session DO does everything it does to that container
 * through this, so a place is one module.
 */
export interface Place {
  /** Starts the container with the session's built-in and connection egress. */
  readonly start: (egress: {
    session: string;
    repo: string;
    connections: readonly string[];
  }) => Effect.Effect<void, ContainerStartFailed>;
  readonly running: () => Effect.Effect<boolean>;
  /** HTTP and WebSocket to a port inside the container: supervisor, saves, terminal, hatch. */
  readonly port: (port: number) => Port;
  readonly destroy: () => Effect.Effect<void>;
}
