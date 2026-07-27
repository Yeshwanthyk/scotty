import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { execute } from "./commands";
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
        outputJson(dependencies.stderr, {
          // oxlint-disable-next-line scotty/no-unknown-error-message -- boundary: Effect.catch has narrowed the value to typed CliError
          error: { code: error.code, message: error.message, hint: error.hint },
        });
        return error.exitCode;
      }),
    ),
    Effect.provide(NodeServices.layer),
    Effect.provide(cliLayer(overrides)),
  );
  // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: main is the single Bun/OS Promise boundary
  return Effect.runPromise(program);
}
