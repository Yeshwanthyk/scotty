import { mkdir, rm, writeFile } from "node:fs/promises";
import { Effect, Exit } from "effect";
import { runCraneProcess } from "../../src/container-image.ts";

const [helper, authRoot, readyPath, signalName] = process.argv.slice(2);
if (!helper || !authRoot || !readyPath || (signalName !== "SIGINT" && signalName !== "SIGTERM"))
  process.exit(2);

await mkdir(authRoot, { recursive: true, mode: 0o700 });
await writeFile(
  `${authRoot}/config.json`,
  `${JSON.stringify({ auths: { "registry.cloudflare.com": { auth: "synthetic-secret" } } })}\n`,
  { mode: 0o600 },
);
const controller = new AbortController();
process.once(signalName, () => controller.abort());
const program = runCraneProcess(helper, {
  args: ["copy"],
  environment: {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: authRoot,
    DOCKER_CONFIG: authRoot,
    READY_PATH: readyPath,
  },
}).pipe(Effect.ensuring(Effect.promise(() => rm(authRoot, { recursive: true, force: true }))));
const exit = await Effect.runPromiseExit(program, { signal: controller.signal });
process.exitCode = Exit.isSuccess(exit) ? 0 : signalName === "SIGINT" ? 130 : 143;
