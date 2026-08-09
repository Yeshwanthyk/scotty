import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const CONTAINER_CONTEXT_PATH = ".alchemy/scotty-container-context";

export const CONTAINER_INPUTS = [
  "package.json",
  "package-lock.json",
  "cli/scotty.ts",
  "cli/src",
  "cli/skills",
  "infra",
  "protocol",
  "worker/package.json",
  "worker/src",
  "worker/container",
];

const isContainerInput = (source) =>
  !source.split(/[\\/]/u).some((segment) => segment === "node_modules" || segment === ".git");

export async function prepareContainerContext(root = process.cwd()) {
  const context = join(root, CONTAINER_CONTEXT_PATH);
  await rm(context, { recursive: true, force: true });
  for (const input of CONTAINER_INPUTS) {
    const destination = join(context, input);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, input), destination, {
      recursive: true,
      filter: isContainerInput,
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await prepareContainerContext();
}
