import type { TimeoutOp } from "./events.js";
import type { State } from "./state.js";

export const deadlines = {
  container: 120_000,
  workspace: 360_000,
  dial: 30_000,
  redial: 2_000,
  prompt: 30_000,
  interrupt: 30_000,
  save: 60_000,
  watch: 600_000,
  idle: 600_000,
  stalled: 1_800_000,
} as const;
export const inactivityTimeout = 900_000;

export type Op = TimeoutOp;
export const reqOp: (req: string) => `req:${string}` = (req) => `req:${req}`;
export const requestFromOp: (op: `req:${string}`) => string = (op) => op.slice(4);
export const idleWindow: (state: State) => number = (state) =>
  state.created?.idleAfter ?? deadlines.idle;
export type Pending = { readonly op: Op; readonly due: number };
export const has: (pending: readonly Pending[], op: Op) => boolean = (pending, op) =>
  pending.some((item) => item.op === op);
export const remove: (pending: readonly Pending[], op: Op) => readonly Pending[] = (pending, op) =>
  pending.filter((item) => item.op !== op);
export const addOnce: (pending: readonly Pending[], op: Op, due: number) => readonly Pending[] = (
  pending,
  op,
  due,
) => (has(pending, op) ? pending : [...pending, { op, due }]);

export const deadline: (state: State) => number | undefined = function deadline(state) {
  return state.pending.reduce<number | undefined>(
    (earliest, item) => (earliest === undefined ? item.due : Math.min(earliest, item.due)),
    undefined,
  );
};
