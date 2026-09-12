import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { execute } from "./commands";
import { CliError, EXIT } from "./core";
import { cliLayer, defaultDependencies, type CliDependencies } from "./dependencies";
import { outputJson } from "./pure";

export function main(
  args = process.argv.slice(2),
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const program = execute(args).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        const failure =
          error ??
          new CliError(
            "internal_error",
            "Scotty failed unexpectedly",
            "Retry the command.",
            EXIT.GENERIC,
          );
        outputJson(dependencies.stderr, {
          error: { code: failure.code, message: failure.message, hint: failure.hint },
        });
        return failure.exitCode;
      }),
    ),
    Effect.provide(NodeServices.layer),
    Effect.provide(cliLayer(overrides)),
  );
  // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: main is the single Bun/OS Promise boundary
  return Effect.runPromise(program);
}
