import type * as cf from "@cloudflare/workers-types";
import { Schema } from "effect";
import type { Effect } from "effect";

export const PlaceKind = Schema.Literals(["cloudflare"]);
// The Cloudflare instance types a session may ask for (owner, 2026-10-19). `lite`, `basic` and
// custom sizes are refused; work bigger than `standard-4` goes to a runner.
export const Size = Schema.Literals(["standard-1", "standard-2", "standard-3", "standard-4"]);
// A session that names no size runs at this one; the fold resolves it.
export const defaultSize: typeof Size.Type = "standard-1";

// Each size's vCPU, memory (GiB) and disk (GB), and Workers Paid's per-second rates beyond the
// included usage, from https://developers.cloudflare.com/containers/platform/pricing/ (read
// 2026-10-20; the page is dated `ratesDated`).
export const ratesDated = "2026-10-05";
export const sizeSpec: Record<
  typeof Size.Type,
  { readonly vcpu: number; readonly memory: number; readonly disk: number }
> = {
  "standard-1": { vcpu: 0.5, memory: 4, disk: 8 },
  "standard-2": { vcpu: 1, memory: 6, disk: 12 },
  "standard-3": { vcpu: 2, memory: 8, disk: 16 },
  "standard-4": { vcpu: 4, memory: 12, disk: 20 },
};
const perSecond = { vcpu: 0.00002, memory: 0.0000025, disk: 0.00000007 };
// USD for an hour of run time at this size, an upper bound for that hour: memory and disk are
// billed as provisioned, vCPU only while busy, here counted as busy throughout; no included usage
// is subtracted.
export const hourlyRate = (size: typeof Size.Type): number => {
  const { vcpu, memory, disk } = sizeSpec[size];
  return 3600 * (vcpu * perSecond.vcpu + memory * perSecond.memory + disk * perSecond.disk);
};

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
