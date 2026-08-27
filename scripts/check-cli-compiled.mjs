import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const run = (command, args, options) => {
  const result = spawnSync(command, args, { cwd: options.cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "null"}`);
  }
};

export const checkCompiledCli = async ({
  root = process.cwd(),
  makeTemporaryDirectory = () => mkdtemp(join(tmpdir(), "scotty-cli-compiled-")),
  execute = run,
  removeTemporaryDirectory = (path) => rm(path, { recursive: true, force: true }),
} = {}) => {
  const temporaryDirectory = await makeTemporaryDirectory();
  const executable = join(temporaryDirectory, "scotty");
  try {
    execute("bun", ["scripts/build-cli.mjs", executable], { cwd: root });
    execute(executable, ["--version"], { cwd: temporaryDirectory });
    execute(executable, ["tools", "list", "--json"], { cwd: temporaryDirectory });
  } finally {
    await removeTemporaryDirectory(temporaryDirectory);
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await checkCompiledCli();
}
