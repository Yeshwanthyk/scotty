import { NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit } from "effect";
import { execute } from "./commands";
import { CliError, EXIT } from "./core";
import { cliLayer, defaultDependencies, type CliDependencies } from "./dependencies";
import { outputJson } from "./pure";

export async function main(
  args = process.argv.slice(2),
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const controller = new AbortController();
  let interruptedExitCode: 130 | 143 = 130;
  const interrupt = (): void => {
    interruptedExitCode = 130;
    controller.abort();
  };
  const terminate = (): void => {
    interruptedExitCode = 143;
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const dependencies = { ...defaultDependencies(controller.signal), ...overrides };
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
    Effect.provide(cliLayer({ ...overrides, signal: controller.signal })),
  );
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: main owns finite OS signal handlers around one CLI Effect execution
  try {
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: main is the single Bun/OS Promise boundary
    const exit = await Effect.runPromiseExit(program, { signal: controller.signal });
    if (Exit.isSuccess(exit)) return exit.value;
    if (Cause.hasInterruptsOnly(exit.cause)) return interruptedExitCode;
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: preserve the prior Promise rejection contract for defects
    return await Effect.runPromise(Effect.failCause(exit.cause));
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
