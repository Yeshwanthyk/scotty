import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import ScottyRunnerLive, { ScottyRunner } from "./runner-object.ts";

export const SCOTTY_RUNNER_WORKER_NAME = "scotty-runner";

export class ScottyRunnerWorker extends Cloudflare.Worker<ScottyRunnerWorker, {}, ScottyRunner>()(
  "ScottyRunnerWorker",
) {}

export const makeScottyRunnerWorker = (name: string) =>
  ScottyRunnerWorker.make(
    {
      main: "worker/src/runner-worker.ts",
      name,
      workersDev: false,
      compatibility: {
        date: "2026-07-20",
        flags: ["nodejs_compat"],
      },
      observability: { enabled: true },
    },
    Effect.gen(function* () {
      yield* ScottyRunner;
      return {};
    }).pipe(Effect.provide(ScottyRunnerLive)),
  );

export default makeScottyRunnerWorker(SCOTTY_RUNNER_WORKER_NAME);
