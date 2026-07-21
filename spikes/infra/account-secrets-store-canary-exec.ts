import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as Alchemy from "alchemy";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { LoggingCli } from "alchemy/Cli/LoggingCli";
import { evalStack } from "alchemy/Stack";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  assertM01BPlan,
  assertM01BScanClean,
  m01bCanaryApprovedLocalPaths,
  m01bCanaryOperationFromEnvironment,
  m01bCanaryPhaseFromEnvironment,
  type M01BPlanEntry,
  M01B_SYNTHETIC_SOURCE_ID,
} from "./account-secrets-store-canary.ts";
import stackEffect from "./account-secrets-store-canary.run.ts";
import { disposableLocalSecretScanMarkers } from "./local-secret-source.ts";

const stage = process.env.ALCHEMY_STAGE ?? "";
const uid = process.getuid?.();
const runtime = Layer.mergeAll(
  LoggingCli,
  Layer.succeed(ArtifactStore, createArtifactStore()),
  Alchemy.AlchemyContextLive,
  Alchemy.localState(),
).pipe(Layer.provideMerge(PlatformServices));

const readStateForScan = (stage: string) =>
  Effect.tryPromise({
    try: async () => {
      const directory = join(process.cwd(), ".alchemy", "state", "ScottyM01BSecretCanary", stage);
      const entries = await readdir(directory, { recursive: true });
      const files = entries.filter((entry) => entry.endsWith(".json"));
      return await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
    },
    catch: () => "state-scan-failed" as const,
  });

const program = Effect.gen(function* () {
  if (uid === undefined) return yield* Effect.fail("invalid-local-canary-context" as const);

  // Every guard intentionally runs before stack construction, credentials,
  // source files, owner keys, planning, or Cloudflare evaluation.
  const phase = m01bCanaryPhaseFromEnvironment(process.env);
  const operation = m01bCanaryOperationFromEnvironment(process.env);
  const paths = m01bCanaryApprovedLocalPaths(stage, process.env, uid);
  // Explicit pre-plan scan boundary for mutation phases only. No stack/provider
  // exists yet. No-op, unbind, and destroy must not open the source at all.
  const markers: readonly string[] =
    phase === "first" || phase === "first-replay" || phase === "update"
      ? yield* disposableLocalSecretScanMarkers(paths, M01B_SYNTHETIC_SOURCE_ID)
      : [];

  return yield* evalStack(
    stackEffect,
    (stack) =>
      Effect.gen(function* () {
        const target =
          phase === "destroy"
            ? { ...stack, resources: {}, bindings: {}, actions: {}, output: {} }
            : stack;
        const plan = yield* Alchemy.Plan.make(target);
        const nodes = [
          ...Object.values(plan.resources),
          ...Object.values(plan.deletions).filter((node) => node !== undefined),
        ];
        const entries: M01BPlanEntry[] = nodes.map((node) => ({
          logicalId: node.resource.LogicalId,
          resource: node.resource.Type,
          action: node.action,
        }));
        assertM01BPlan(
          entries,
          phase,
          Object.keys(plan.actions).length + Object.keys(plan.actionDeletions).length,
        );

        assertM01BScanClean(plan, ...markers);
        process.stdout.write(`${JSON.stringify({ phase, entries }, undefined, 2)}\n`);
        if (operation === "plan") return;

        const output = yield* Alchemy.apply(plan);
        assertM01BScanClean(output, ...markers);
        if (phase !== "destroy") {
          const state = yield* readStateForScan(stage);
          if (state.length === 0) return yield* Effect.fail("state-scan-empty" as const);
          assertM01BScanClean(state.join("\n"), ...markers);
        }
        process.stdout.write("M01B guarded apply completed.\n");
      }),
    { stage },
  ).pipe(Effect.provide(runtime));
});

const exit = await Effect.runPromiseExit(program);
if (Exit.isFailure(exit)) {
  process.stderr.write(
    "M01B guarded lifecycle failed; no raw cause is printed. Verify approvals, phase, operation, local files, plan shape, scan results, credentials, and provider state.\n",
  );
  process.exitCode = 1;
}
