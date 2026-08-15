import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { projectContainerPiInstall } from "../../scripts/project-container-pi-install.mjs";
import {
  CONTAINER_CONTEXT_BUDGET,
  CONTAINER_CONTEXT_PATH,
  CONTAINER_IMAGE_BUDGET,
  isExcludedProjectPath,
  isIncludedProjectPath,
  isSafeProjectPath,
  normalizeProjectPath,
  projectContainerContextInputs,
} from "./deployment-packaging.ts";

export {
  ARCHIVE_PUBLIC_ASSETS,
  CLI_SOURCE_TREES,
  CONTAINER_CONTEXT_BUDGET,
  CONTAINER_CONTEXT_PATH,
  CONTAINER_IMAGE_BUDGET,
  CONTAINER_INPUTS,
  CONTAINER_RUNTIME_ASSETS,
  CONTAINER_STATIC_INPUTS,
  DEPLOYMENT_ARCHIVE_NAME,
  DEPLOYMENT_ENTRIES,
  DEPLOYMENT_EXCLUSIONS,
  DEPLOYMENT_INPUTS,
  DEPLOYMENT_PACKAGING,
  coversProjectPath,
  isCoveredByProjectInputs,
  isDeploymentArchiveFileName,
  isExcludedProjectPath,
  isIncludedProjectPath,
  isSafeProjectPath,
  normalizeProjectPath,
  projectContainerContextInputs,
} from "./deployment-packaging.ts";

const execFileAsync = promisify(execFile);

export const assertSafeProjectPath = (source) => {
  const normalized = normalizeProjectPath(source);
  if (!isSafeProjectPath(normalized)) {
    throw new Error(`Deployment input is outside the repository: ${source}`);
  }
  return normalized;
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
    const normalized = assertSafeProjectPath(source);
    if (isExcludedProjectPath(normalized)) continue;
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

const collectPackagedFiles = async (root, directory, files) => {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = join(directory, entry.name);
    const relativePath = normalizeProjectPath(relative(root, child));
    if (isExcludedProjectPath(relativePath)) continue;
    if (entry.isDirectory()) await collectPackagedFiles(root, child, files);
    else if (entry.isFile()) files.push(relativePath);
  }
};

export async function listPackagedFiles(root, inputs) {
  const files = [];
  for (const input of inputs) {
    const normalized = assertSafeProjectPath(input);
    if (isExcludedProjectPath(normalized)) continue;
    const path = join(root, normalized);
    const metadata = await stat(path);
    if (metadata.isDirectory()) await collectPackagedFiles(root, path, files);
    else if (metadata.isFile()) files.push(normalized);
  }
  return files;
}

export async function materializeProjectInputs(root, destination, inputs) {
  for (const input of inputs) {
    const normalized = assertSafeProjectPath(input);
    if (isExcludedProjectPath(normalized)) continue;
    const output = join(destination, normalized);
    await mkdir(dirname(output), { recursive: true });
    await cp(join(root, normalized), output, {
      recursive: true,
      filter: (source) => isIncludedProjectPath(normalizeProjectPath(relative(root, source))),
    });
  }
}

const collectAllFilesWithBytes = async (root, directory, files) => {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = join(directory, entry.name);
    const relativePath = normalizeProjectPath(relative(root, child));
    if (entry.isDirectory()) await collectAllFilesWithBytes(root, child, files);
    else if (entry.isFile()) {
      const metadata = await stat(child);
      files.push({ path: relativePath, bytes: metadata.size });
    }
  }
};

export async function measureContainerContext(contextRoot) {
  const files = [];
  await collectAllFilesWithBytes(contextRoot, contextRoot, files);
  return {
    files: files.map((file) => file.path),
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

export async function assertContainerContextBudget(contextRoot) {
  const measured = await measureContainerContext(contextRoot);
  const excluded = measured.files.filter((source) => isExcludedProjectPath(source));
  if (excluded.length > 0) {
    throw new Error(
      `Prepared container context includes excluded paths: ${excluded.slice(0, 8).join(", ")}`,
    );
  }
  const playwrightCore = measured.files.find((source) => source.includes("playwright-core/"));
  if (playwrightCore !== undefined) {
    throw new Error(
      `Prepared container context includes a pre-install Playwright payload: ${playwrightCore}`,
    );
  }
  if (measured.fileCount > CONTAINER_CONTEXT_BUDGET.maxFiles) {
    throw new Error(
      `Prepared container context has ${measured.fileCount} files; budget is ${CONTAINER_CONTEXT_BUDGET.maxFiles} files`,
    );
  }
  if (measured.bytes > CONTAINER_CONTEXT_BUDGET.maxBytes) {
    throw new Error(
      `Prepared container context is ${measured.bytes} bytes; budget is ${CONTAINER_CONTEXT_BUDGET.maxBytes} bytes`,
    );
  }
  return measured;
}

export const assertContainerImageBudget = (sizeBytes) => {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`Container image size must be a non-negative integer, got ${sizeBytes}`);
  }
  if (sizeBytes > CONTAINER_IMAGE_BUDGET.maxBytes) {
    throw new Error(
      `Container image ${CONTAINER_IMAGE_BUDGET.metric} is ${sizeBytes} bytes; budget is ${CONTAINER_IMAGE_BUDGET.maxBytes} bytes`,
    );
  }
  return sizeBytes;
};

export async function inspectContainerImageBudget(
  image,
  { exec = execFileAsync, inspectArgs = ["image", "inspect", image, "--format", "{{.Size}}"] } = {},
) {
  let stdout;
  try {
    ({ stdout } = await exec("docker", inspectArgs));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to ${CONTAINER_IMAGE_BUDGET.metric} for ${image}: ${detail}`);
  }
  const raw = String(stdout ?? "").trim();
  const sizeBytes = Number(raw);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`${CONTAINER_IMAGE_BUDGET.metric} for ${image} was not an integer: ${raw}`);
  }
  return assertContainerImageBudget(sizeBytes);
}

export async function prepareContainerContext(
  root = process.cwd(),
  {
    discoverCliInputs = discoverContainerCliInputs,
    inputs,
    projectPiInstall = projectContainerPiInstall,
  } = {},
) {
  const contextInputs =
    inputs === undefined ? projectContainerContextInputs(await discoverCliInputs(root)) : inputs;
  const context = join(root, CONTAINER_CONTEXT_PATH);
  await rm(context, { recursive: true, force: true });
  await materializeProjectInputs(root, context, contextInputs);
  await projectPiInstall(context);
  await assertContainerContextBudget(context);
}
