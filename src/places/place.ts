import type * as cf from "@cloudflare/workers-types";
import { Schema } from "effect";
import type { Effect } from "effect";

export const PlaceKind = Schema.Literals(["cloudflare"]);

export class ContainerStartFailed extends Schema.TaggedError<ContainerStartFailed>()(
  "ContainerStartFailed",
  {},
) {}

/**
 * Where one session's container runs. The Session DO does everything it does to that container
 * through this, so a place is one module.
 */
export interface Place {
  /** Starts the container with the session's `github.internal` and `files.internal` egress. */
  readonly start: (egress: {
    session: string;
    repo: string;
  }) => Effect.Effect<void, ContainerStartFailed>;
  readonly running: () => boolean;
  /** HTTP and WebSocket to a port inside the container: supervisor, saves, terminal, hatch. */
  readonly port: (port: number) => cf.Fetcher;
  readonly destroy: () => Effect.Effect<void>;
}
