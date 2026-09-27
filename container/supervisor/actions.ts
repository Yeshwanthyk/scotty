import { Deferred, Effect, Exit, Queue } from "effect";
import type { AgentError } from "./runner.js";

type Job = {
  readonly action: Effect.Effect<void, AgentError>;
  readonly result: Deferred.Deferred<Exit.Exit<void, AgentError>>;
};

// One queue and one consumer belong to each runner scope. The first req enqueues
// synchronously in arrival order; Requests joins duplicates before calling run.
export class Actions {
  private constructor(private readonly jobs: Queue.Queue<Job>) {}
  static make(): Effect.Effect<Actions> {
    return Queue.unbounded<Job>().pipe(Effect.map((jobs) => new Actions(jobs)));
  }
  get drain(): Effect.Effect<never> {
    return Effect.forever(
      Queue.take(this.jobs).pipe(
        Effect.flatMap(({ action, result }) =>
          Effect.exit(action).pipe(Effect.flatMap((outcome) => Deferred.succeed(result, outcome))),
        ),
      ),
    );
  }
  run(action: Effect.Effect<void, AgentError>): Effect.Effect<void, AgentError> {
    return Effect.gen({ self: this }, function* () {
      const completion = yield* Effect.sync(() => {
        const result = Deferred.makeUnsafe<Exit.Exit<void, AgentError>>();
        Queue.offerUnsafe(this.jobs, { action, result });
        return result;
      });
      const outcome = yield* Deferred.await(completion);
      if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
    });
  }
}
