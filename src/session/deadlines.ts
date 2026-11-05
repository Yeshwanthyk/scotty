import type { TimeoutOp } from "./events.js";
import type { State } from "./state.js";

export const deadlines = {
  container: 120_000,
  // Covers the supervisor waiting out a GitHub rate limit on the clone.
  workspace: 360_000,
  dial: 30_000,
  redial: 2_000,
  prompt: 30_000,
  interrupt: 30_000,
  save: 60_000,
  // Re-watches a running machine; shorter than a Cloudflare container's inactivity timeout
  // (src/places/cloudflare.ts), so the alarm wakes an evicted Session DO before Cloudflare stops it.
  watch: 600_000,
  // A running session with no open turn sleeps after this; a create may ask for less.
  idle: 600_000,
  // An open turn with no agent output this long is stuck: it is interrupted, then stopped.
  stalled: 1_800_000,
  // A pause unanswered this long asks the place for the machine's status.
  pause: 60_000,
} as const;

export type Op = TimeoutOp;
export const reqOp = (req: string): `req:${string}` => `req:${req}`;
export const requestFromOp = (op: `req:${string}`): string => op.slice(4);
export const idleWindow = (state: State): number => state.created?.idleAfter ?? deadlines.idle;
export type Pending = { readonly op: Op; readonly due: number };
export const has = (pending: readonly Pending[], op: Op): boolean =>
  pending.some((item) => item.op === op);
export const remove = (pending: readonly Pending[], op: Op): readonly Pending[] =>
  pending.filter((item) => item.op !== op);
export const addOnce = (pending: readonly Pending[], op: Op, due: number): readonly Pending[] =>
  has(pending, op) ? pending : [...pending, { op, due }];

export function deadline(state: State): number | undefined {
  return state.pending.reduce<number | undefined>(
    (earliest, item) => (earliest === undefined ? item.due : Math.min(earliest, item.due)),
    undefined,
  );
}
