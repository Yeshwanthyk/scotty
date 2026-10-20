import type * as cf from "@cloudflare/workers-types";
import { Schema } from "effect";
import type { Effect } from "effect";

export const PlaceKind = Schema.Literals(["cloudflare"]);
// The Cloudflare instance types a session may ask for (owner, 2026-10-19). `lite`, `basic` and
// custom sizes are refused; work bigger than `standard-4` goes to a runner.
export const Size = Schema.Literals(["standard-1", "standard-2", "standard-3", "standard-4"]);
// A session that names no size runs at this one; the fold resolves it.
export const defaultSize: typeof Size.Type = "standard-1";

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
  /** Starts the container at its size, with the session's built-in and connection egress. */
  readonly start: (input: {
    session: string;
    repo: string;
    connections: readonly string[];
    size: typeof Size.Type;
  }) => Effect.Effect<void, ContainerStartFailed>;
  readonly running: () => Effect.Effect<boolean>;
  /** HTTP and WebSocket to a port inside the container: supervisor, saves, terminal, hatch. */
  readonly port: (port: number) => Port;
  readonly destroy: () => Effect.Effect<void>;
}
