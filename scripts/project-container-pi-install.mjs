import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "./is-direct-run.mjs";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const PI_SUBAGENTS_SOURCE = "sources/pi-subagents";
export const INDEXED_PI_PACKAGES_RELATIVE = "worker/container/pi-packages";
export const PI_ONLY_BACKEND_NAMES = 'export const BACKEND_NAMES = ["pi"] as const;';
export const UPSTREAM_BACKEND_NAMES =
  'export const BACKEND_NAMES = ["pi", "claude", "codex"] as const;';
export const UPSTREAM_RUNTIME_IMPORTS = `import { claudeBackend } from "./backends/claude.ts";
import { codexBackend } from "./backends/codex.ts";
`;
export const UPSTREAM_RUNTIME_BACKENDS =
  "const backends: SubagentBackend[] = [piBackend, claudeBackend, codexBackend];";
export const PI_ONLY_RUNTIME_BACKENDS = "const backends: SubagentBackend[] = [piBackend];";
export const PI_SUBAGENTS_OMITTED_PACKAGES = Object.freeze(["@anthropic-ai/claude-agent-sdk"]);

export const UPSTREAM_SPAWN_DESCRIPTION =
  "Spawn a background subagent: a fully autonomous, headless agent with its own context window. You choose the harness it runs on: pi (in-process pi session, inherits this environment's tools and config), claude (Claude Code), or codex (Codex CLI). Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you as a message when it settles, or collect it explicitly with subagent_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Max 4 subagents can be running at once across all harnesses.";
export const PI_ONLY_SPAWN_DESCRIPTION =
  "Spawn a background subagent: a fully autonomous, headless agent with its own context window. It runs on pi (in-process pi session, inherits this environment's tools and config). Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you as a message when it settles, or collect it explicitly with subagent_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Max 4 subagents can be running at once.";
export const UPSTREAM_SPAWN_SNIPPET =
  "Spawn a background subagent on a chosen harness (pi, Claude Code, or Codex; own context, normal tools) for a self-contained task";
export const PI_ONLY_SPAWN_SNIPPET =
  "Spawn a background subagent on pi (in-process session, own context, normal tools) for a self-contained task";
export const UPSTREAM_SPAWN_GUIDELINE =
  "Pick the subagent harness deliberately: pi unless you have a reason to prefer Claude Code or Codex (e.g. the user asked for one, or the task suits that harness).";
export const PI_ONLY_SPAWN_GUIDELINE =
  "Scotty's image-local pi-subagents install is Pi-only; always spawn with harness pi.";
export const UPSTREAM_HARNESS_DESCRIPTION =
  'Harness to run the subagent on: "pi" (in-process pi session; inherits this environment), "claude" (Claude Code), or "codex" (Codex CLI). Choose deliberately per task.';
export const PI_ONLY_HARNESS_DESCRIPTION =
  'Harness to run the subagent on. Scotty ships Pi only; use "pi" (in-process pi session; inherits this environment).';
export const UPSTREAM_MODEL_DESCRIPTION =
  'Model hint, interpreted by the chosen harness (pi: "provider/model-id" or model id; claude: model alias like "sonnet"/"opus"; codex: model slug). Omit for the harness default (pi inherits the current model).';
export const PI_ONLY_MODEL_DESCRIPTION =
  'Model hint for pi ("provider/model-id" or model id). Omit to inherit the current model.';
export const UPSTREAM_REASONING_DESCRIPTION =
  "Reasoning effort on a shared scale; the harness maps it to its nearest native equivalent (pi thinking level, codex reasoning effort, claude thinking budget). Omit for the harness default (pi inherits the current level).";
export const PI_ONLY_REASONING_DESCRIPTION =
  "Reasoning effort on pi's thinking scale. Omit to inherit the current level.";

export const UPSTREAM_SKILL_PI_DEFAULT =
  "**Best default:** Use when the user does not request another harness. It inherits the parent model and thinking level when `model` or `reasoning_effort` is omitted.";
export const PI_ONLY_SKILL_PI_DEFAULT =
  "**Best default:** Scotty's image is Pi-only. Always spawn with harness `pi`. It inherits the parent model and thinking level when `model` or `reasoning_effort` is omitted.";
export const UPSTREAM_SKILL_UNAVAILABLE_HARNESSES = `## Claude Code Harness

**Harness:** \`claude\`
**Prompt nicknames:** “claude”, “Claude Code”, “claude agent”, “claude subagent”, "cc"
**Best default:** use the latest fable model on high reasoning. Do not default to anything else, if the user does not specify, use fable.

| Model hint | Model               | Recommended effort |
| ---------- | ------------------- | ------------------ |
| \`fable\`    | latest Claude Fable | \`high\`             |

**Thinking budgets:** \`off\`, \`minimal\`, \`low\`, \`medium\`, \`high\`, \`xhigh\`, \`max\`. The extension maps these to Claude thinking-token budgets: 0, 1,024, 4,096, 10,000, 16,000, 32,000, and 63,999 tokens respectively.

Requires Claude Code to be installed and authenticated.

## Codex Harness

**Harness:** \`codex\`
**Prompt nicknames:** “codex”, “Codex CLI”, “codex agent”, “codex subagent”
**Best default:** \`gpt-5.6-sol\` with \`high\` effort for coding work. Do not use anything other than sol unless the user specifically asks for it.

| Model           | Recommended effort |
| --------------- | ------------------ |
| \`gpt-5.6-sol\`   | \`high\`             |
| \`gpt-5.6-terra\` | \`high\`             |
| \`gpt-5.6-luna\`  | \`high\`             |

**Thinking budgets accepted by the extension:** \`off\`, \`minimal\`, \`low\`, \`medium\`, \`high\`, \`xhigh\`, \`max\`. Codex maps these to the nearest effort supported by the selected model; \`off\`/\`minimal\` become \`minimal\`, while \`max\` becomes the highest extension-supported Codex effort.

Requires the Codex CLI to be installed and authenticated.

`;
export const UPSTREAM_SKILL_SPAWN =
  "Call `subagent_spawn` with a complete `prompt`, short `name`, chosen `harness`, and optional `working_dir`, `model`, and `reasoning_effort`. At most four subagents run concurrently.";
export const PI_ONLY_SKILL_SPAWN =
  "Call `subagent_spawn` with a complete `prompt`, short `name`, harness `pi`, and optional `working_dir`, `model`, and `reasoning_effort`. At most four subagents run concurrently.";
export const UPSTREAM_SUBAGENTS_README =
  "It provides headless Pi, Claude Code, and Codex subagents with asynchronous result delivery, wait/check/cancel tools, an interactive `/subagents` transcript/takeover UI, and persistent read-only BTW side conversations.";
export const PI_ONLY_SUBAGENTS_README =
  "It provides headless Pi subagents with asynchronous result delivery, wait/check/cancel tools, an interactive `/subagents` transcript/takeover UI, and persistent read-only BTW side conversations. Scotty's image is Pi-only.";

export const PI_SUBAGENTS_RUNTIME_REWRITES = Object.freeze([
  Object.freeze({
    label: "pi-subagents runtime imports",
    search: UPSTREAM_RUNTIME_IMPORTS,
    replacement: "",
  }),
  Object.freeze({
    label: "pi-subagents runtime backends",
    search: UPSTREAM_RUNTIME_BACKENDS,
    replacement: PI_ONLY_RUNTIME_BACKENDS,
  }),
]);
export const PI_SUBAGENTS_DOMAIN_REWRITES = Object.freeze([
  Object.freeze({
    label: "pi-subagents backend names",
    search: UPSTREAM_BACKEND_NAMES,
    replacement: PI_ONLY_BACKEND_NAMES,
  }),
]);
export const PI_SUBAGENTS_PROMPT_REWRITES = Object.freeze([
  Object.freeze({
    label: "pi-subagents spawn description",
    search: UPSTREAM_SPAWN_DESCRIPTION,
    replacement: PI_ONLY_SPAWN_DESCRIPTION,
  }),
  Object.freeze({
    label: "pi-subagents spawn snippet",
    search: UPSTREAM_SPAWN_SNIPPET,
    replacement: PI_ONLY_SPAWN_SNIPPET,
  }),
  Object.freeze({
    label: "pi-subagents spawn guideline",
    search: UPSTREAM_SPAWN_GUIDELINE,
    replacement: PI_ONLY_SPAWN_GUIDELINE,
  }),
  Object.freeze({
    label: "pi-subagents harness description",
    search: UPSTREAM_HARNESS_DESCRIPTION,
    replacement: PI_ONLY_HARNESS_DESCRIPTION,
  }),
  Object.freeze({
    label: "pi-subagents model description",
    search: UPSTREAM_MODEL_DESCRIPTION,
    replacement: PI_ONLY_MODEL_DESCRIPTION,
  }),
  Object.freeze({
    label: "pi-subagents reasoning description",
    search: UPSTREAM_REASONING_DESCRIPTION,
    replacement: PI_ONLY_REASONING_DESCRIPTION,
  }),
]);
export const PI_SUBAGENTS_SKILL_REWRITES = Object.freeze([
  Object.freeze({
    label: "pi-subagents SKILL.md default",
    search: UPSTREAM_SKILL_PI_DEFAULT,
    replacement: PI_ONLY_SKILL_PI_DEFAULT,
  }),
  Object.freeze({
    label: "pi-subagents SKILL.md unavailable harnesses",
    search: UPSTREAM_SKILL_UNAVAILABLE_HARNESSES,
    replacement: "",
  }),
  Object.freeze({
    label: "pi-subagents SKILL.md spawn",
    search: UPSTREAM_SKILL_SPAWN,
    replacement: PI_ONLY_SKILL_SPAWN,
  }),
]);
export const PI_SUBAGENTS_README_REWRITES = Object.freeze([
  Object.freeze({
    label: "pi-subagents README intro",
    search: UPSTREAM_SUBAGENTS_README,
    replacement: PI_ONLY_SUBAGENTS_README,
  }),
]);

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const encodeJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

export const writeFileAtomic = async (path, contents) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
};

const writeJsonAtomic = async (path, value) => {
  await writeFileAtomic(path, encodeJson(value));
};

export const replaceExact = (source, search, replacement, label) => {
  if (source.includes(search)) {
    const count = source.split(search).length - 1;
    if (count !== 1) {
      throw new Error(`Pi install projection expected a unique ${label} rewrite, found ${count}`);
    }
    return source.replace(search, replacement);
  }
  if (replacement === "" || source.includes(replacement)) return source;
  throw new Error(
    `Pi install projection missing ${label}: expected upstream or already-projected form`,
  );
};

export const applyRewrites = (source, rewrites) => {
  let next = source;
  for (const { search, replacement, label } of rewrites) {
    next = replaceExact(next, search, replacement, label);
  }
  return next;
};

const rewriteFile = async (path, rewrites) => {
  if (!existsSync(path)) return false;
  const source = await readFile(path, "utf8");
  const projected = applyRewrites(source, rewrites);
  if (projected !== source) await writeFileAtomic(path, projected);
  return true;
};

export const parentLockPackagePath = (packagePath) => {
  if (packagePath === "") return null;
  const marker = "/node_modules/";
  const index = packagePath.lastIndexOf(marker);
  return index === -1 ? "" : packagePath.slice(0, index);
};

export const resolveLockDependency = (lock, fromPath, name) => {
  let current = fromPath;
  while (true) {
    const candidate = current === "" ? `node_modules/${name}` : `${current}/node_modules/${name}`;
    if (lock.packages?.[candidate]) return candidate;
    if (current === "") return undefined;
    current = parentLockPackagePath(current);
    if (current === null) return undefined;
  }
};

const dependencyNames = (pkg, fields) => {
  const names = [];
  for (const field of fields) {
    names.push(...Object.keys(pkg?.[field] ?? {}));
  }
  return names;
};

export const canonicalizeNpmLock = (lock) => {
  const packages = {};
  for (const key of Object.keys(lock.packages ?? {}).sort()) {
    packages[key] = lock.packages[key];
  }
  return { ...lock, packages };
};

export const pruneNpmLockPackages = (lock, rootFields) => {
  const packages = { ...lock.packages };
  const root = { ...packages[""] };
  for (const [field, value] of Object.entries(rootFields)) {
    if (value === undefined) delete root[field];
    else root[field] = value;
  }
  packages[""] = root;
  const projected = { ...lock, packages };
  const keep = new Set([""]);
  const queue = [""];
  while (queue.length > 0) {
    const current = queue.shift();
    const pkg = projected.packages[current];
    const fields =
      current === ""
        ? ["dependencies", "optionalDependencies", "devDependencies"]
        : ["dependencies", "optionalDependencies"];
    for (const name of dependencyNames(pkg, fields)) {
      const resolved = resolveLockDependency(projected, current, name);
      if (resolved === undefined || keep.has(resolved)) continue;
      keep.add(resolved);
      queue.push(resolved);
    }
  }
  for (const key of Object.keys(projected.packages)) {
    if (!keep.has(key)) delete projected.packages[key];
  }
  return canonicalizeNpmLock(projected);
};

const omitDependencies = (pkg, names) => {
  const dependencies = { ...pkg.dependencies };
  for (const name of names) delete dependencies[name];
  return { ...pkg, dependencies };
};

export const lockPackageKeyFor = (name) => `node_modules/${name}`;

export const lockContainsPackage = (lock, name) =>
  Object.keys(lock.packages ?? {}).some(
    (key) => key === lockPackageKeyFor(name) || key.endsWith(`/node_modules/${name}`),
  );

export const assertLockOmitsPackages = (lock, names, label) => {
  const present = names.filter((name) => lockContainsPackage(lock, name));
  if (present.length > 0) {
    throw new Error(`${label} lock still contains ${present.join(", ")}`);
  }
};

export async function regenerateNpmPackageLock(packageRoot, { exec = execFile } = {}) {
  await exec(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
    ],
    { cwd: packageRoot },
  );
}

const projectPackageLock = async (packageRoot, packageJson, options = {}) => {
  const lockPath = join(packageRoot, "package-lock.json");
  if (!existsSync(lockPath)) return;
  if (options.regenerateLock === true) {
    await (options.regenerateNpmPackageLock ?? regenerateNpmPackageLock)(packageRoot, options);
  }
  const lock = await readJson(lockPath);
  const projected = pruneNpmLockPackages(lock, {
    dependencies: packageJson.dependencies ?? {},
    peerDependencies: packageJson.peerDependencies,
    devDependencies: packageJson.devDependencies,
  });
  await writeJsonAtomic(lockPath, projected);
  return projected;
};

const writeProjectedPackage = async (packageRoot, packageJson, options = {}) => {
  const packageJsonPath = join(packageRoot, "package.json");
  const packageTemp = `${packageJsonPath}.${process.pid}.tmp`;
  await writeFile(packageTemp, encodeJson(packageJson));
  await rename(packageTemp, packageJsonPath);
  return projectPackageLock(packageRoot, packageJson, options);
};

export const isPiSubagentsProjected = (packageJson) =>
  PI_SUBAGENTS_OMITTED_PACKAGES.every((name) => packageJson.dependencies?.[name] === undefined);

export const assertPiSubagentsSkill = (skill) => {
  if (
    /## Claude Code Harness|## Codex Harness|Requires Claude Code|Requires the Codex CLI/u.test(
      skill,
    )
  ) {
    throw new Error("pi-subagents SKILL.md still advertises unavailable harnesses");
  }
  if (
    !skill.includes("Scotty's image is Pi-only") ||
    !skill.includes("Always spawn with harness")
  ) {
    throw new Error("pi-subagents SKILL.md is not Pi-only");
  }
};

export const assertPiSubagentsReadme = (readme) => {
  if (/Claude Code|Codex CLI|Codex subagents/u.test(readme)) {
    throw new Error("pi-subagents README still advertises unavailable harnesses");
  }
  if (!readme.includes("Scotty's image is Pi-only")) {
    throw new Error("pi-subagents README is not Pi-only");
  }
};

export const assertPiSubagentsSource = (runtime, domain, prompt, skill, readme) => {
  if (!runtime.includes(PI_ONLY_RUNTIME_BACKENDS)) {
    throw new Error("pi-subagents runtime.ts is not Pi-only");
  }
  if (/claudeBackend|codexBackend|claude-agent-sdk/u.test(runtime)) {
    throw new Error("pi-subagents runtime.ts still references Claude or Codex backends");
  }
  if (!domain.includes(PI_ONLY_BACKEND_NAMES)) {
    throw new Error("pi-subagents domain.ts is not Pi-only");
  }
  if (/Claude Code|Codex CLI/u.test(prompt)) {
    throw new Error("pi-subagents prompt.ts still advertises Claude or Codex");
  }
  if (skill !== undefined) assertPiSubagentsSkill(skill);
  if (readme !== undefined) assertPiSubagentsReadme(readme);
};

export async function assertProjectedPiSubagents(packageRoot) {
  const runtime = await readFile(join(packageRoot, "extensions/subagents/src/runtime.ts"), "utf8");
  const domain = await readFile(join(packageRoot, "extensions/subagents/src/domain.ts"), "utf8");
  const prompt = await readFile(join(packageRoot, "extensions/subagents/src/prompt.ts"), "utf8");
  const skillPath = join(packageRoot, "skills/subagents/SKILL.md");
  const readmePath = join(packageRoot, "README.md");
  const skill = existsSync(skillPath) ? await readFile(skillPath, "utf8") : undefined;
  const readme = existsSync(readmePath) ? await readFile(readmePath, "utf8") : undefined;
  assertPiSubagentsSource(runtime, domain, prompt, skill, readme);
  const packageJson = await readJson(join(packageRoot, "package.json"));
  if (!isPiSubagentsProjected(packageJson)) {
    throw new Error("pi-subagents package.json still depends on omitted packages");
  }
  const lockPath = join(packageRoot, "package-lock.json");
  if (existsSync(lockPath)) {
    assertLockOmitsPackages(
      await readJson(lockPath),
      PI_SUBAGENTS_OMITTED_PACKAGES,
      "pi-subagents",
    );
  }
}

export function isIndexedVendorPiPackagesRoot(piPackagesRoot) {
  try {
    const repo = execFileSync("git", ["-C", piPackagesRoot, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (repo.length === 0) return false;
    return realpathSync(piPackagesRoot) === realpathSync(join(repo, INDEXED_PI_PACKAGES_RELATIVE));
  } catch {
    return false;
  }
}

export function assertWritablePiPackagesRoot(piPackagesRoot) {
  if (isIndexedVendorPiPackagesRoot(piPackagesRoot)) {
    throw new Error(
      `Refusing to project indexed vendor Pi packages at ${piPackagesRoot}. Pass --pi-packages with a copy.`,
    );
  }
}

export async function projectPiSubagentsInstall(packageRoot, options = {}) {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) return { projected: false };
  const packageJson = await readJson(packageJsonPath);
  if (!isPiSubagentsProjected(packageJson)) {
    const projectedJson = omitDependencies(packageJson, PI_SUBAGENTS_OMITTED_PACKAGES);
    const lock = await writeProjectedPackage(packageRoot, projectedJson, options);
    if (lock) assertLockOmitsPackages(lock, PI_SUBAGENTS_OMITTED_PACKAGES, "pi-subagents");
  } else {
    const lock = await projectPackageLock(packageRoot, packageJson, options);
    if (lock) assertLockOmitsPackages(lock, PI_SUBAGENTS_OMITTED_PACKAGES, "pi-subagents");
  }

  await rewriteFile(
    join(packageRoot, "extensions/subagents/src/runtime.ts"),
    PI_SUBAGENTS_RUNTIME_REWRITES,
  );
  await rewriteFile(
    join(packageRoot, "extensions/subagents/src/domain.ts"),
    PI_SUBAGENTS_DOMAIN_REWRITES,
  );
  await rewriteFile(
    join(packageRoot, "extensions/subagents/src/prompt.ts"),
    PI_SUBAGENTS_PROMPT_REWRITES,
  );
  await rewriteFile(join(packageRoot, "skills/subagents/SKILL.md"), PI_SUBAGENTS_SKILL_REWRITES);
  await rewriteFile(join(packageRoot, "README.md"), PI_SUBAGENTS_README_REWRITES);

  if (existsSync(join(packageRoot, "extensions/subagents/src/runtime.ts"))) {
    await assertProjectedPiSubagents(packageRoot);
  }
  return { projected: true };
}

export async function assertProjectedPiImage(piPackagesRoot) {
  await assertProjectedPiSubagents(join(piPackagesRoot, PI_SUBAGENTS_SOURCE));
}

export function resolvePiPackagesRoot(root = process.cwd(), options = {}) {
  if (typeof options.piPackagesRoot === "string") return options.piPackagesRoot;
  return join(root, INDEXED_PI_PACKAGES_RELATIVE);
}

export async function projectContainerPiInstall(root = process.cwd(), options = {}) {
  const piPackagesRoot = resolvePiPackagesRoot(root, options);
  assertWritablePiPackagesRoot(piPackagesRoot);
  const subagents = await projectPiSubagentsInstall(
    join(piPackagesRoot, PI_SUBAGENTS_SOURCE),
    options,
  );
  return { piPackagesRoot, subagents };
}

export const parseProjectContainerPiInstallArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--pi-packages") {
      options.piPackagesRoot = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--regenerate-lock") {
      options.regenerateLock = true;
    } else if (argv[index] === "--assert-image") {
      options.assertImage = true;
    }
  }
  return options;
};

if (isDirectRun(import.meta.url, process.argv[1])) {
  const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
  const parsed = parseProjectContainerPiInstallArgs(process.argv.slice(2));
  const piPackagesRoot = resolvePiPackagesRoot(root, parsed);
  if (parsed.assertImage) {
    await assertProjectedPiImage(piPackagesRoot);
    process.stdout.write(`Asserted projected Pi image under ${piPackagesRoot}.\n`);
  } else {
    const result = await projectContainerPiInstall(root, parsed);
    process.stdout.write(
      `Projected Pi package installs under ${result.piPackagesRoot} (subagents=${result.subagents.projected}).\n`,
    );
  }
}
