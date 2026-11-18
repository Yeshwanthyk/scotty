import { Effect, Schema } from "effect";
import { CliFailure, client, failure } from "../../cli/client.js";
import { SessionEvent } from "../../src/session/events.js";
import { fold, initial } from "../../src/session/fold.js";

export const Log = Schema.Array(SessionEvent);

const limit = 420_000;

export const waiter =
  (request: ReturnType<typeof client>, prefix: string) =>
  <A>(
    read: () => Effect.Effect<A, CliFailure>,
    done: (value: A) => boolean,
    options?: { readonly stopped?: "expected" },
  ) =>
    Effect.gen(function* () {
      const started = Date.now();
      while (Date.now() - started < limit) {
        const value = yield* read();
        if (done(value)) return value;
        const log = yield* request(`${prefix}/log`, Log);
        const state = log.reduce(fold, initial);
        const ended =
          state.phase === "failed" ||
          (state.phase === "stopped" && options?.stopped !== "expected");
        if (ended) {
          const last = yield* read();
          if (done(last)) return last;
          const error = log.findLast((event) => event.kind === "sup.error");
          const why = [
            state.failure?.code,
            error?.kind === "sup.error" ? `${error.code}: ${error.message}` : undefined,
          ].filter((part) => part !== undefined);
          return yield* failure(
            "session_ended",
            `Session ${state.phase} while waiting${why.length > 0 ? ` (${why.join("; ")})` : ""}`,
            "scotty doctor",
          );
        }
        yield* Effect.sleep("2 seconds");
      }
      return yield* failure("timeout", "Timed out waiting for session outcome", "scotty doctor");
    });
