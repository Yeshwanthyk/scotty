import { join } from "node:path";
import { Effect, Schema } from "effect";
import { CliError, EXIT } from "./core";
import { FileSystem } from "./services";

const DeploymentPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  cliVersion: Schema.NonEmptyString,
  installationName: Schema.NonEmptyString,
  accountId: Schema.NonEmptyString,
  planFingerprint: Schema.NonEmptyString,
  bundleDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});

export type DeploymentPlan = typeof DeploymentPlanSchema.Type;

const decodeDeploymentPlan = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DeploymentPlanSchema),
  { onExcessProperty: "error" },
);

export const deploymentPlanPath = (home: string): string =>
  join(home, ".config", "scotty", "deployment-plan.json");

const invalidPlan = (path: string): CliError =>
  new CliError(
    "deployment_plan_invalid",
    "The saved deployment plan is invalid",
    `Remove ${path} and run scotty deploy --plan again.`,
    EXIT.USAGE,
  );

export const readDeploymentPlan = Effect.fnUntraced(function* (home: string) {
  const path = deploymentPlanPath(home);
  const fileSystem = yield* FileSystem;
  const text = yield* fileSystem.readPrivateText(path).pipe(
    Effect.catch((error) => {
      if (error.reason === "missing") return Effect.succeed(undefined);
      if (
        error.reason === "permissions" ||
        error.reason === "not_file" ||
        error.reason === "symlink"
      )
        return Effect.fail(
          new CliError(
            "deployment_plan_permissions",
            "The saved deployment plan must be a private regular file",
            `Use a non-symlinked mode-0600 file at ${path}.`,
            EXIT.USAGE,
          ),
        );
      return Effect.fail(
        new CliError(
          "deployment_plan_read_failed",
          "Could not read the saved deployment plan",
          `Check permissions on ${path}.`,
          EXIT.GENERIC,
        ),
      );
    }),
  );
  if (text === undefined) return undefined;
  return yield* decodeDeploymentPlan(text).pipe(Effect.mapError(() => invalidPlan(path)));
});

export const writeDeploymentPlan = Effect.fnUntraced(function* (
  home: string,
  plan: DeploymentPlan,
) {
  const fileSystem = yield* FileSystem;
  const path = deploymentPlanPath(home);
  yield* fileSystem.withLock(
    path,
    fileSystem.writeSecure(path, `${JSON.stringify(plan, null, 2)}\n`),
  );
});

export const removeDeploymentPlan = Effect.fnUntraced(function* (home: string) {
  const fileSystem = yield* FileSystem;
  yield* fileSystem
    .remove(deploymentPlanPath(home))
    .pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.void
          : Effect.fail(
              new CliError(
                "deployment_plan_remove_failed",
                "The applied deployment plan could not be removed",
                `Remove ${deploymentPlanPath(home)} before the next deployment.`,
                EXIT.GENERIC,
              ),
            ),
      ),
    );
});
