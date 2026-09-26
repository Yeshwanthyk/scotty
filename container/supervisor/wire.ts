import { Result, Schema } from "effect";
import { FromSupervisor, type FromSupervisorMessage } from "../../protocol/supervisor.js";

type WithoutEnvelope<T> = T extends { gen: number; n: number } ? Omit<T, "gen" | "n"> : never;
export type Output = WithoutEnvelope<FromSupervisorMessage>;
export class WireError extends Schema.TaggedError<WireError>()("WireError", {
  message: Schema.String,
}) {}
export type Wire = {
  readonly gen: number | undefined;
  readonly boot: string;
  readonly next: number;
  readonly acknowledged: number;
  readonly outbox: readonly FromSupervisorMessage[];
};
export const initialWire = (boot: string): Wire => ({
  gen: undefined,
  boot,
  next: 1,
  acknowledged: 0,
  outbox: [],
});

// Only this pure transition allocates n. A bad output is a typed failure,
// not a thrown defect that could kill the socket consumer.
export function emit(
  state: Wire & { readonly gen: number },
  output: Output,
): Result.Result<{ wire: Wire; message: FromSupervisorMessage }, WireError> {
  const decoded = Schema.decodeUnknownResult(FromSupervisor)({
    ...output,
    gen: state.gen,
    n: state.next,
  });
  if (Result.isFailure(decoded))
    return Result.fail(new WireError({ message: "invalid supervisor output" }));
  const message = decoded.success;
  return Result.succeed({
    wire: { ...state, next: state.next + 1, outbox: [...state.outbox, message] },
    message,
  });
}
export function acknowledge(state: Wire, after: number): Wire {
  const acknowledged = Math.max(state.acknowledged, Math.min(after, state.next - 1));
  return { ...state, acknowledged, outbox: state.outbox.filter((entry) => entry.n > acknowledged) };
}
export function dial(
  state: Wire,
  gen: number,
  after: number,
):
  | { readonly conflict: true }
  | {
      readonly conflict: false;
      readonly wire: Wire;
      readonly messages: readonly FromSupervisorMessage[];
    } {
  if (state.gen !== undefined && state.gen !== gen) return { conflict: true };
  const greeting: FromSupervisorMessage = {
    type: "hello",
    gen,
    n: 1,
    version: "step-2",
    boot: state.boot,
  };
  const initialized: Wire =
    state.next === 1 ? { ...state, gen, next: 2, outbox: [greeting] } : { ...state, gen };
  const replay = initialized.outbox.filter((message) => message.n > Math.max(after, 1));
  return {
    conflict: false,
    wire: acknowledge(initialized, after),
    messages: [greeting, ...replay],
  };
}
