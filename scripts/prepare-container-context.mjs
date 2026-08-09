import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const CONTAINER_CONTEXT_PATH = ".alchemy/scotty-container-context";

export const CONTAINER_STATIC_INPUTS = [
  "package.json",
  "package-lock.json",
  "worker/package.json",
  "worker/container",
];

const execFileAsync = promisify(execFile);

const isContainerInput = (source) =>
  !source.split(/[\\/]/u).some((segment) => segment === "node_modules" || segment === ".git");

const isSafeProjectPath = (source) => {
  const normalized = source.replaceAll("\\", "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
};

export function projectContainerCliInputs(metafile) {
  if (
    metafile === null ||
    typeof metafile !== "object" ||
    Array.isArray(metafile) ||
    metafile.inputs === null ||
    typeof metafile.inputs !== "object" ||
    Array.isArray(metafile.inputs)
  ) {
    throw new Error("Bun CLI build metadata did not contain an input map.");
  }
  const inputs = [];
  for (const source of Object.keys(metafile.inputs)) {
    const normalized = source.replaceAll("\\", "/");
    if (!isSafeProjectPath(normalized)) {
      throw new Error(`Bun CLI build input is outside the repository: ${source}`);
    }
    if (normalized.startsWith("node_modules/")) continue;
    inputs.push(normalized);
  }
  return [...new Set(inputs)].sort();
}

export async function discoverContainerCliInputs(root = process.cwd(), execute = execFileAsync) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "scotty-container-cli-"));
  try {
    const outputDirectory = join(temporaryDirectory, "out");
    const metafilePath = join(temporaryDirectory, "metafile.json");
    await execute(
      "bun",
      [
        "build",
        "cli/scotty.ts",
        "--target=bun",
        `--outdir=${outputDirectory}`,
        `--metafile=${metafilePath}`,
      ],
      { cwd: root },
    );
    return projectContainerCliInputs(JSON.parse(await readFile(metafilePath, "utf8")));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const coveredByStaticInput = (source) =>
  CONTAINER_STATIC_INPUTS.some((input) => source === input || source.startsWith(`${input}/`));

export async function prepareContainerContext(
  root = process.cwd(),
  { discoverCliInputs = discoverContainerCliInputs } = {},
) {
  const cliInputs = await discoverCliInputs(root);
  const context = join(root, CONTAINER_CONTEXT_PATH);
  await rm(context, { recursive: true, force: true });
  for (const input of [
    ...CONTAINER_STATIC_INPUTS,
    ...cliInputs.filter((source) => !coveredByStaticInput(source)),
  ]) {
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
