import { Deferred, Effect, Exit, Queue } from "effect";
import type { AgentError } from "./runner.js";

type Job = {
  readonly action: Effect.Effect<void, AgentError>;
  readonly result: Deferred.Deferred<Exit.Exit<void, AgentError>>;
};

export class Actions {
  private constructor(private readonly jobs: Queue.Queue<Job>) {}
  static make() {
    return Queue.unbounded<Job>().pipe(
      Effect.map((jobs) => new Actions(jobs)),
    ) satisfies Effect.Effect<Actions>;
  }
  get drain() {
    return Effect.forever(
      Queue.take(this.jobs).pipe(
        Effect.flatMap(({ action, result }) =>
          Effect.exit(action).pipe(Effect.flatMap((outcome) => Deferred.succeed(result, outcome))),
        ),
      ),
    ) satisfies Effect.Effect<never>;
  }
  run(action: Effect.Effect<void, AgentError>) {
    return Effect.gen({ self: this }, function* () {
      const completion = yield* Effect.sync(() => {
        const result = Deferred.makeUnsafe<Exit.Exit<void, AgentError>>();
        Queue.offerUnsafe(this.jobs, { action, result });
        return result;
      });
      const outcome = yield* Deferred.await(completion);
      if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
    }) satisfies Effect.Effect<void, AgentError>;
  }
}
