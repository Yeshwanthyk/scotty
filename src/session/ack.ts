import type { State } from "./state.js";

export const shouldAck = (state: State, n: number, force = false) =>
  (force || n - state.lastAckN >= 50) satisfies boolean;

export const ackRecorded: (
  state: State,
  output: { readonly gen: number; readonly n: number },
) => boolean = (state, output) =>
  state.gen === output.gen &&
  state.connected &&
  state.lastN === output.n &&
  state.lastAckN === output.n &&
  state.lastAckSeq === state.lastSeq;
