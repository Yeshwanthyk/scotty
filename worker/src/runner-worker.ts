import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { PREBUILT_RUNNER_WORKER_ENTRY } from "../../cli/src/prebuilt-worker-bundles.ts";
import ScottyRunnerLive, { ScottyRunner } from "./runner-object.ts";

export const SCOTTY_RUNNER_WORKER_NAME = "scotty-runner";

export class ScottyRunnerWorker extends Cloudflare.Worker<ScottyRunnerWorker, {}, ScottyRunner>()(
  "ScottyRunnerWorker",
) {}

export const makeScottyRunnerWorker = (
  name: string,
  options: { readonly prebuiltWorkers?: boolean } = {},
) =>
  ScottyRunnerWorker.make(
    {
      main:
        options.prebuiltWorkers === true
          ? PREBUILT_RUNNER_WORKER_ENTRY
          : "worker/src/runner-worker.ts",
      ...(options.prebuiltWorkers === true ? { bundle: false as const } : {}),
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
