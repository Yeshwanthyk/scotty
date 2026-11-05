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
// "½ vCPU, 4 GiB": what a size gives, for help text.
export const sizeShape = (size: typeof Size.Type): string => {
  const { vcpu, memory } = sizeSpec[size];
  return `${vcpu === 0.5 ? "½" : vcpu} vCPU, ${memory} GiB`;
};
const perSecond = { vcpu: 0.00002, memory: 0.0000025, disk: 0.00000007 };
// USD for an hour of run time at this size, an upper bound for that hour: memory and disk are
// billed as provisioned, vCPU only while busy, here counted as busy throughout; no included usage
// is subtracted.
export const hourlyRate = (size: typeof Size.Type): number => {
  const { vcpu, memory, disk } = sizeSpec[size];
  return 3600 * (vcpu * perSecond.vcpu + memory * perSecond.memory + disk * perSecond.disk);
};

// A place's own call failed or went unanswered; `op` names it. Says nothing about the machine.
export class PlaceFailed extends Schema.TaggedError<PlaceFailed>()("PlaceFailed", {
  op: Schema.Literals(["create", "pause", "resume", "remove", "status", "watch"]),
}) {}

/** Names one machine (container, sandbox or VM) at a place. Not a secret. */
export type Handle = string;

/** What a port answered: the parts the Session DO reads, and the whole of it to pass on. */
export interface PortResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
  readonly json: () => Promise<unknown>;
}

/** Plain HTTP and WebSocket to one port; all any place can honestly offer. */
export interface Port {
  readonly fetch: (
    url: string,
    init?: {
      readonly method?: string;
      readonly headers?: Headers | Record<string, string>;
      readonly body?: ArrayBuffer | ReadableStream<Uint8Array> | null;
      readonly redirect?: "manual";
    },
  ) => Promise<PortResponse>;
  /**
   * Opens a WebSocket to `url`, accepted and ready to use, or undefined when the far end refused
   * the upgrade. A socket that opens after `signal` aborts is closed.
   */
  readonly socket: (
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ) => Promise<WebSocket | undefined>;
}

/** How a watched machine ended, or `lost` when the watch broke and says nothing about it. */
export type Exit =
  | { readonly reason: "exited" }
  | { readonly reason: "crashed"; readonly exitCode: number }
  | { readonly reason: "lost" };

/**
 * Where one session's machine runs. The Session DO reaches that machine only through this, so a
 * place is one module. What a place keeps between turns is learned from its answers.
 */
export interface Place {
  /**
   * Makes the machine for this session and generation, with the session's egress and the
   * supervisor's key `key` (hex). Idempotent by session and gen: a retried create gets the
   * same handle back, and a new gen never gets a machine already reported gone.
   */
  readonly create: (input: {
    readonly session: string;
    readonly gen: number;
    readonly repo: string;
    readonly connections: readonly string[];
    readonly size: typeof Size.Type;
    readonly key: string;
  }) => Effect.Effect<Handle, PlaceFailed>;
  readonly pause: (handle: Handle) => Effect.Effect<"paused" | "gone", PlaceFailed>;
  readonly resume: (handle: Handle) => Effect.Effect<"running" | "gone", PlaceFailed>;
  /** Removing a handle that is already gone succeeds. */
  readonly remove: (handle: Handle) => Effect.Effect<void, PlaceFailed>;
  readonly status: (handle: Handle) => Effect.Effect<"running" | "paused" | "gone", PlaceFailed>;
  /** HTTP and WebSocket to a port inside the machine: supervisor, saves, terminal, hatch. */
  readonly port: (handle: Handle, port: number) => Port;
  /**
   * Only where the place reports an exit as it happens. The outer effect arms the watch (it fails
   * when the machine can't be watched yet); the inner one waits for the exit.
   */
  readonly watch?: (handle: Handle) => Effect.Effect<Effect.Effect<Exit>, PlaceFailed>;
}
