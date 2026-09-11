import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import {
  CONTAINER_BUILD_ENTRYPOINTS,
  CONTAINER_CONTEXT_BUDGET,
  CONTAINER_CONTEXT_PATH,
  CONTAINER_IMAGE_BUDGET,
  CONTAINER_STATIC_INPUTS,
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
        ...CONTAINER_BUILD_ENTRYPOINTS,
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

export const listDockerfileProjectCopySources = (dockerfile) => {
  const sources = [];
  for (const line of dockerfile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("COPY ") || trimmed.startsWith("COPY --from=")) continue;
    const tokens = trimmed
      .slice("COPY ".length)
      .split(/\s+/u)
      .filter((token) => !token.startsWith("--"));
    sources.push(...tokens.slice(0, -1).map(assertSafeProjectPath));
  }
  return sources;
};

export async function assertContainerCopyInputs(contextRoot) {
  const dockerfilePath = join(contextRoot, "worker/container/Dockerfile");
  const sources = listDockerfileProjectCopySources(await readFile(dockerfilePath, "utf8"));
  const missing = [];
  for (const source of sources) {
    const present = await access(join(contextRoot, source)).then(
      () => true,
      () => false,
    );
    if (!present) missing.push(source);
  }
  if (missing.length > 0)
    throw new Error(
      `Prepared container context is missing Docker COPY inputs: ${missing.join(", ")}`,
    );
  return sources;
}

const dockerignoreRuleMatches = (source, rawPattern) => {
  const pattern = rawPattern.replace(/^\//u, "").replace(/\/$/u, "");
  if (pattern === "**") return true;
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else expression += ".*";
      } else expression += "[^/]*";
    } else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  return pattern.includes("/")
    ? new RegExp(`^${expression}(?:/.*)?$`, "u").test(source)
    : new RegExp(`(?:^|/)${expression}(?:/|$)`, "u").test(source);
};

const dockerignoreAllows = (source, rules) => {
  let included = true;
  for (const rule of rules) {
    const negated = rule.startsWith("!");
    const pattern = negated ? rule.slice(1) : rule;
    if (pattern !== "" && dockerignoreRuleMatches(source, pattern)) included = negated;
  }
  return included;
};

export async function assertRootDockerignoreInputs(root, inputs = CONTAINER_STATIC_INPUTS) {
  const rules = (await readFile(join(root, ".dockerignore"), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const excluded = inputs.filter((source) => !dockerignoreAllows(source, rules));
  if (excluded.length > 0)
    throw new Error(
      `Root .dockerignore excludes required container inputs: ${excluded.join(", ")}`,
    );
  return inputs;
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
  { discoverCliInputs = discoverContainerCliInputs, inputs } = {},
) {
  const contextInputs =
    inputs === undefined ? projectContainerContextInputs(await discoverCliInputs(root)) : inputs;
  const context = join(root, CONTAINER_CONTEXT_PATH);
  const hasRootDockerignore = await access(join(root, ".dockerignore")).then(
    () => true,
    () => false,
  );
  if (hasRootDockerignore)
    await assertRootDockerignoreInputs(root, await listPackagedFiles(root, contextInputs));
  await rm(context, { recursive: true, force: true });
  await materializeProjectInputs(root, context, contextInputs);
  const hasDockerfile = await access(join(context, "worker/container/Dockerfile")).then(
    () => true,
    () => false,
  );
  if (hasDockerfile) await assertContainerCopyInputs(context);
  await assertContainerContextBudget(context);
}
