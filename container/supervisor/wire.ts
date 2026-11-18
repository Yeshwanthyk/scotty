import { Result, Schema } from "effect";
import {
  FromSupervisor,
  type FromSupervisorMessage,
  supervisorVersion,
  type Workspace,
  type StartupTiming,
} from "../../protocol/supervisor.js";

type WithoutEnvelope<T> = T extends { gen: number; n: number } ? Omit<T, "gen" | "n"> : never;
export type Output = WithoutEnvelope<FromSupervisorMessage>;
class WireError extends Schema.TaggedError<WireError>()("WireError", {
  message: Schema.String,
}) {}
type Wire = {
  readonly gen: number | undefined;
  readonly boot: string;
  readonly workspace: Workspace | undefined;
  readonly next: number;
  readonly acknowledged: number;
  readonly outbox: readonly FromSupervisorMessage[];
};
export const initialWire: (boot: string, workspace: Workspace | undefined) => Wire = (
  boot,
  workspace,
) => ({
  gen: undefined,
  boot,
  workspace,
  next: 1,
  acknowledged: 0,
  outbox: [],
});

export const emit: (
  state: Wire & { readonly gen: number },
  output: Output,
) => Result.Result<{ wire: Wire; message: FromSupervisorMessage }, WireError> = function emit(
  state,
  output,
) {
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
};
export const acknowledge: (state: Wire, after: number) => Wire = function acknowledge(
  state,
  after,
) {
  const acknowledged = Math.max(state.acknowledged, Math.min(after, state.next - 1));
  return { ...state, acknowledged, outbox: state.outbox.filter((entry) => entry.n > acknowledged) };
};
export const dial: (
  state: Wire,
  gen: number,
  after: number,
  startup?: typeof StartupTiming.Type,
) =>
  | { readonly conflict: true }
  | {
      readonly conflict: false;
      readonly wire: Wire;
      readonly messages: readonly FromSupervisorMessage[];
    } = function dial(state, gen, after, startup?) {
  if (state.gen !== undefined && state.gen !== gen) return { conflict: true };
  const greeting: FromSupervisorMessage = {
    type: "hello",
    gen,
    n: 1,
    version: supervisorVersion,
    boot: state.boot,
    ...(state.workspace === undefined ? {} : { workspace: state.workspace }),
    ...(startup === undefined ? {} : { startup }),
  };
  const initialized: Wire =
    state.next === 1 ? { ...state, gen, next: 2, outbox: [greeting] } : { ...state, gen };
  const replay = initialized.outbox.filter((message) => message.n > Math.max(after, 1));
  return {
    conflict: false,
    wire: acknowledge(initialized, after),
    messages: [greeting, ...replay],
  };
};
