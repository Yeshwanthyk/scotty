import { Deferred, Effect, Exit } from "effect";
import type { AgentError } from "./runner.js";

export class Requests {
  private readonly results = new Map<string, Deferred.Deferred<Exit.Exit<void, AgentError>>>();

  run(req: string, action: Effect.Effect<void, AgentError>) {
    return Effect.gen({ self: this }, function* () {
      const entry = yield* Effect.sync(() => {
        const existing = this.results.get(req);
        if (existing !== undefined) return { result: existing, first: false };
        const result = Deferred.makeUnsafe<Exit.Exit<void, AgentError>>();
        this.results.set(req, result);
        return { result, first: true };
      });
      if (entry.first) {
        const outcome = yield* Effect.exit(action);
        yield* Deferred.succeed(entry.result, outcome);
      }
      const outcome = yield* Deferred.await(entry.result);
      if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
    }) satisfies Effect.Effect<void, AgentError>;
  }
}
