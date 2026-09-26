import type { State } from "./state.js";

export const deadlines = {
  container: 120_000,
  workspace: 120_000,
  dial: 30_000,
  redial: 2_000,
  prompt: 30_000,
  interrupt: 30_000,
} as const;

export type Op = "container" | "workspace" | "dial" | "redial" | `req:${string}`;
export const reqOp = (req: string): `req:${string}` => `req:${req}`;
export const isOp = (value: string): value is Op =>
  ["container", "workspace", "dial", "redial"].includes(value) || value.startsWith("req:");
export const requestFromOp = (op: `req:${string}`): string => op.slice(4);
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
