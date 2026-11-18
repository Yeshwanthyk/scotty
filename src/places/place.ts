import { Effect, Schema } from "effect";

export const PlaceKind = Schema.Literals(["cloudflare", "daytona"]);
export const defaultPlace: typeof PlaceKind.Type = "cloudflare";
export const Size = Schema.Literals(["standard-1", "standard-2", "standard-3", "standard-4"]);
export const defaultSize: typeof Size.Type = "standard-1";

/**
 * What is fixed about each place: the sizes it makes, smallest first, and whether the supervisor
 * reaches the Worker through its own socket because the place can't intercept the machine's
 * requests to `github.internal` and the rest.
 */
export const placeCatalog = {
  cloudflare: { sizes: Size.literals, tunnel: false },
  daytona: { sizes: ["standard-1", "standard-2"], tunnel: true },
} as const satisfies Record<
  typeof PlaceKind.Type,
  { readonly sizes: readonly (typeof Size.Type)[]; readonly tunnel: boolean }
>;

/** The places that act with an API key the owner saves with `scotty login <place>`. */
export const KeyedPlace = Schema.Literals(["daytona"]);
export const placeKeys = {
  daytona: {
    env: "DAYTONA_API_KEY",
    pattern: /^dtn_[A-Za-z0-9_-]{20,200}$/,
    site: "app.daytona.io",
  },
} as const satisfies Record<
  typeof KeyedPlace.Type & typeof PlaceKind.Type,
  { readonly env: string; readonly pattern: RegExp; readonly site: string }
>;
/** The largest size `place` makes that is no bigger than `size`. */
export const fitSize: (place: typeof PlaceKind.Type, size: typeof Size.Type) => typeof Size.Type = (
  place,
  size,
) => {
  const offered: readonly (typeof Size.Type)[] = placeCatalog[place].sizes;
  const wanted = Size.literals.indexOf(size);
  return offered.findLast((item) => Size.literals.indexOf(item) <= wanted) ?? offered[0] ?? size;
};

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
export const sizeShape: (size: typeof Size.Type) => string = (size) => {
  const { vcpu, memory } = sizeSpec[size];
  return `${vcpu === 0.5 ? "½" : vcpu} vCPU, ${memory} GiB`;
};
const perSecond = { vcpu: 0.00002, memory: 0.0000025, disk: 0.00000007 };
export const hourlyRate: (size: typeof Size.Type) => number = (size) => {
  const { vcpu, memory, disk } = sizeSpec[size];
  return 3600 * (vcpu * perSecond.vcpu + memory * perSecond.memory + disk * perSecond.disk);
};

export class PlaceFailed extends Schema.TaggedError<PlaceFailed>()("PlaceFailed", {
  op: Schema.Literals(["create", "pause", "resume", "remove", "status", "watch", "port"]),
}) {}

export class PortFailed extends Schema.TaggedError<PortFailed>()("PortFailed", {}) {}

const acceptSocket = (response: object) => {
  const candidate: unknown = Reflect.get(response, "webSocket");
  if (
    !(candidate instanceof WebSocket) ||
    !("accept" in candidate) ||
    typeof candidate.accept !== "function"
  )
    return undefined;
  candidate.accept();
  return candidate;
};

/**
 * The WebSocket a `fetch` with `Upgrade: websocket` answered with, accepted, or undefined when the
 * far end refused the upgrade. Interrupted before the answer, it closes the socket when it opens.
 */
export const upgrade: (
  open: () => Promise<object>,
) => Effect.Effect<WebSocket | undefined, PortFailed> = (open) =>
  Effect.callback((resume) => {
    let interrupted = false;
    open().then(
      (response) => {
        if (interrupted) acceptSocket(response)?.close();
        else resume(Effect.succeed(acceptSocket(response)));
      },
      () => {
        if (!interrupted) resume(Effect.fail(new PortFailed()));
      },
    );
    return Effect.sync(() => {
      interrupted = true;
    });
  });

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
  /**
   * A place should answer with a real `Response`: a caller that hands the result to
   * `HttpServerResponse.raw` streams its body only when the runtime object is one
   * (vendor/effect HttpServerResponse.ts, the `Raw` case).
   */
  readonly fetch: (
    url: string,
    init?: {
      readonly method?: string;
      readonly headers?: Headers | Record<string, string>;
      readonly body?: ArrayBuffer | ReadableStream<Uint8Array> | null;
      readonly redirect?: "manual";
    },
  ) => Effect.Effect<PortResponse, PortFailed>;
  /** A WebSocket to `url`, as `upgrade` answers it. */
  readonly socket: (
    url: string,
    headers: Record<string, string>,
  ) => Effect.Effect<WebSocket | undefined, PortFailed>;
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
   * Makes the machine for this session and generation, running and with the supervisor's key
   * `key` (hex). Idempotent by session and gen: a retried create gets the
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
  readonly port: (handle: Handle, port: number) => Effect.Effect<Port, PlaceFailed>;
  /**
   * Only where the place reports an exit as it happens. The outer effect arms the watch (it fails
   * when the machine can't be watched yet); the inner one waits for the exit.
   */
  readonly watch?: (handle: Handle) => Effect.Effect<Effect.Effect<Exit>, PlaceFailed>;
}
