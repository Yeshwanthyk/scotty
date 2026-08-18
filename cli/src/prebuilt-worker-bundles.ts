import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";

export const PREBUILT_WORKER_ROOT = "worker/prebuilt" as const;
export const PREBUILT_WORKER_MARKER = `${PREBUILT_WORKER_ROOT}/.scotty-prebuilt` as const;
export const PREBUILT_MAIN_WORKER_DIR = `${PREBUILT_WORKER_ROOT}/main` as const;
export const PREBUILT_RUNNER_WORKER_DIR = `${PREBUILT_WORKER_ROOT}/runner` as const;
export const PREBUILT_MAIN_WORKER_ENTRY = `${PREBUILT_MAIN_WORKER_DIR}/index.js` as const;
export const PREBUILT_RUNNER_WORKER_ENTRY = `${PREBUILT_RUNNER_WORKER_DIR}/index.js` as const;

// Alchemy's effect-entry virtual bundle bakes stack.name and stack.stage into the runner
// worker isolate. Scotty worker code never reads Stack.name, but the runner bridge still
// carries the values, so build-time bundles use placeholders and deploy-time rewrites them
// in the extracted archive temp root before Alchemy reads prebuilt bytes off disk.
export const PREBUILT_STACK_NAME_PLACEHOLDER = "__SCOTTY_STACK_NAME_PLACEHOLDER__" as const;
export const PREBUILT_STACK_STAGE_PLACEHOLDER = "__SCOTTY_STACK_STAGE_PLACEHOLDER__" as const;

export const MAIN_WORKER_EXPORTS = Object.freeze([
  "ScottySandbox",
  "ScottyAuthRegistry",
  "ScottyRunnerRegistry",
  "ScottySandboxConfig",
] as const);

export const RUNNER_WORKER_EXPORTS = Object.freeze(["ScottyRunner"] as const);

const ALLOWED_IMPORT_PREFIXES = Object.freeze(["cloudflare:", "node:"] as const);

const NODE_BUILTIN_MODULE_SPECIFIERS = Object.freeze(
  new Set([
    "assert",
    "assert/strict",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "dns/promises",
    "domain",
    "events",
    "fs",
    "fs/promises",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "path/posix",
    "path/win32",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "readline/promises",
    "repl",
    "sqlite",
    "stream",
    "stream/consumers",
    "stream/promises",
    "stream/web",
    "string_decoder",
    "sys",
    "timers",
    "timers/promises",
    "tls",
    "tty",
    "url",
    "trace_events",
    "util",
    "util/types",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib",
  ]),
);

const isAbsoluteModuleSpecifier = (specifier: string): boolean =>
  specifier.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(specifier);

const codeIndexes = (source: string): Uint8Array => {
  const indexes = new Uint8Array(source.length);
  let quote: "'" | '"' | "`" | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    indexes[index] = 1;
    if (character === "'" || character === '"' || character === "`") quote = character;
  }
  return indexes;
};

const MODULE_SPECIFIER_PATTERN =
  /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)(['"])([^'"]+)\1/gu;
const EXPORT_CLASS_PATTERN = /export\s+class\s+(\w+)/gu;
const EXPORT_NAMED_PATTERN = /export\s*\{([^}]+)\}/gu;

export const isPrebuiltWorkerDeploymentRoot = (root: string): boolean =>
  existsSync(`${root}/${PREBUILT_WORKER_MARKER}`);

export const requiredPrebuiltWorkerEntries = Object.freeze([
  PREBUILT_MAIN_WORKER_ENTRY,
  PREBUILT_RUNNER_WORKER_ENTRY,
  PREBUILT_WORKER_MARKER,
] as const);

export const missingPrebuiltWorkerEntries = (root: string): readonly string[] =>
  requiredPrebuiltWorkerEntries.filter((entry) => !existsSync(`${root}/${entry}`));

const escapeJavaScriptStringContent = (value: string): string =>
  JSON.stringify(value)
    .slice(1, -1)
    .replaceAll("'", "\\u0027")
    .replaceAll("`", "\\u0060")
    .replaceAll("$", "\\u0024");

export const replaceRunnerStackPlaceholders = (
  source: string,
  stackName: string,
  stage: string,
): string =>
  source
    .replaceAll(PREBUILT_STACK_NAME_PLACEHOLDER, escapeJavaScriptStringContent(stackName))
    .replaceAll(PREBUILT_STACK_STAGE_PLACEHOLDER, escapeJavaScriptStringContent(stage));

export const remainingRunnerStackPlaceholders = (source: string): readonly string[] =>
  [PREBUILT_STACK_NAME_PLACEHOLDER, PREBUILT_STACK_STAGE_PLACEHOLDER].filter((placeholder) =>
    source.includes(placeholder),
  );

export const rewritePrebuiltRunnerStackPlaceholders = async (
  root: string,
  stackName: string,
  stage: string,
): Promise<void> => {
  const runnerDirectory = `${root}/${PREBUILT_RUNNER_WORKER_DIR}`;
  const entries = await readdir(runnerDirectory, { withFileTypes: true });
  const rewrittenSources: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const path = `${runnerDirectory}/${entry.name}`;
    const source = await readFile(path, "utf8");
    const rewritten = replaceRunnerStackPlaceholders(source, stackName, stage);
    if (rewritten !== source) await writeFile(path, rewritten);
    rewrittenSources.push(rewritten);
  }
  const remaining = remainingRunnerStackPlaceholders(rewrittenSources.join("\n"));
  if (remaining.length > 0) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw, scotty/no-error-constructor -- boundary: filesystem bundle rewrite must reject unresolved build placeholders
    throw new Error(`Prebuilt runner worker retains stack placeholders: ${remaining.join(", ")}`);
  }
};

export const collectExportClassNames = (source: string): readonly string[] => {
  const names = new Set<string>();
  for (const match of source.matchAll(EXPORT_CLASS_PATTERN)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  for (const match of source.matchAll(EXPORT_NAMED_PATTERN)) {
    const block = match[1];
    if (block === undefined) continue;
    for (const segment of block.split(",")) {
      const trimmed = segment.trim();
      if (trimmed.length === 0) continue;
      const exported = trimmed
        .split(/\s+as\s+/u)
        .at(-1)
        ?.trim();
      if (exported !== undefined && exported.length > 0) names.add(exported);
    }
  }
  return [...names];
};

export const missingWorkerBundleExports = (
  sources: readonly string[],
  requiredExports: readonly string[],
): readonly string[] => {
  const exported = new Set(sources.flatMap((source) => collectExportClassNames(source)));
  return requiredExports.filter((name) => !exported.has(name));
};

export const collectBarePackageImports = (source: string): readonly string[] => {
  const imports = new Set<string>();
  const indexes = codeIndexes(source);
  for (const match of source.matchAll(MODULE_SPECIFIER_PATTERN)) {
    if (match.index === undefined || indexes[match.index] !== 1) continue;
    const specifier = match[2];
    if (specifier === undefined) continue;
    if (ALLOWED_IMPORT_PREFIXES.some((prefix) => specifier.startsWith(prefix))) continue;
    if (NODE_BUILTIN_MODULE_SPECIFIERS.has(specifier)) continue;
    if (specifier.startsWith(".") || isAbsoluteModuleSpecifier(specifier)) continue;
    imports.add(specifier);
  }
  return [...imports];
};

export const barePackageImports = (sources: readonly string[]): readonly string[] =>
  sources.flatMap((source) => collectBarePackageImports(source));

export const missingRunnerStackPlaceholders = (source: string): readonly string[] => {
  const missing: string[] = [];
  if (!source.includes(PREBUILT_STACK_NAME_PLACEHOLDER)) {
    missing.push(PREBUILT_STACK_NAME_PLACEHOLDER);
  }
  if (!source.includes(PREBUILT_STACK_STAGE_PLACEHOLDER)) {
    missing.push(PREBUILT_STACK_STAGE_PLACEHOLDER);
  }
  return missing;
};
