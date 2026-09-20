import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CONTAINER_STATIC_INPUTS, DEPLOYMENT_INPUTS } from "../cli/src/deployment-packaging.mjs";

const exact = (path) => ({ path, tree: false });
const tree = (path) => ({ path, tree: true });
const projectInputs = (inputs) =>
  inputs.map((path) => (path.includes(".") ? exact(path) : tree(path)));

const CLI_BUILD_INPUTS = Object.freeze([
  exact("package.json"),
  exact("package-lock.json"),
  exact(".nvmrc"),
  exact(".bun-version"),
]);

const GATE_OWNERS = Object.freeze([
  exact(".github/workflows/ci.yml"),
  exact("scripts/ci-path-gates.mjs"),
  exact("scripts/ci-path-gates.test.mjs"),
]);

// Current native Codex server metafile closure. Protocol leaves stay exact so
// unrelated CLI/runtime protocol changes do not rebuild the image.
const CONTAINER_SOURCE_INPUTS = Object.freeze([
  tree("worker/src/agent/codex"),
  exact("worker/src/credentials/managed.ts"),
  exact("worker/src/runtime-cli/paths.ts"),
  exact("worker/src/sandbox/config-contracts.ts"),
  exact("worker/src/sandbox/runtime.ts"),
  exact("worker/src/sandbox/workspace.ts"),
  exact("worker/src/session/contracts.ts"),
  exact("worker/src/shared/bounded-http.ts"),
  exact("worker/src/shared/digest.ts"),
  exact("worker/src/shared/json.ts"),
  ...[
    "agent-selection.ts",
    "cloud-settings.ts",
    "codex-app-server.ts",
    "codex-model-capabilities.ts",
    "conversation.ts",
    "credentials.ts",
    "pi-console-shared.mjs",
    "pi-console.ts",
    "repository.ts",
    "tool-display-text.ts",
  ].map((name) => exact(`protocol/${name}`)),
]);

const CONTAINER_BUILD_INPUTS = Object.freeze([
  ...projectInputs(CONTAINER_STATIC_INPUTS),
  ...CONTAINER_SOURCE_INPUTS,
  ...GATE_OWNERS,
  exact(".dockerignore"),
  exact("cli/src/deployment-packaging.mjs"),
  exact("cli/src/deployment-packaging.ts"),
  exact("scripts/prepare-container-context.mjs"),
  exact("scripts/prepare-container-context.test.mjs"),
]);

const CLEAN_ROOM_CLI_INPUTS = Object.freeze([
  ...projectInputs(DEPLOYMENT_INPUTS),
  ...CLI_BUILD_INPUTS,
  ...GATE_OWNERS,
  exact("tsconfig.json"),
  exact("cli/tsconfig.json"),
  exact("scripts/build-runtime-cli.mjs"),
  exact("scripts/check-cli-clean-room.mjs"),
  exact("scripts/check-cli-clean-room.test.mjs"),
  exact("worker/container/Dockerfile"),
  exact(".github/workflows/release-cli.yml"),
]);

const STANDALONE_INPUTS = Object.freeze([
  ...projectInputs(DEPLOYMENT_INPUTS),
  ...CLI_BUILD_INPUTS,
  ...GATE_OWNERS,
  tree("ui"),
  exact("tsconfig.json"),
  exact("cli/tsconfig.json"),
  exact("scripts/build-cli.mjs"),
  exact("scripts/bundle-deployment-workers.mjs"),
  exact("scripts/prebuilt-worker-imports.mjs"),
  exact("scripts/check-cli-standalone-deploy.mjs"),
  exact("scripts/check-cli-standalone-deploy.test.mjs"),
  exact(".github/workflows/release-cli.yml"),
]);

const FINAL_IMAGE_INPUTS = Object.freeze([
  ...CONTAINER_BUILD_INPUTS,
  exact("scripts/check-container-image.mjs"),
  exact("scripts/check-container-image.test.mjs"),
  exact("scripts/check-language-package-downloads.sh"),
  exact("scripts/container-probe-process.mjs"),
  exact("scripts/container-probe-process.test.mjs"),
  exact("scripts/make-image-release.mjs"),
  exact("scripts/make-image-release.test.mjs"),
  exact(".github/workflows/release-cli.yml"),
]);

const CODEX_NATIVE_INPUTS = Object.freeze([
  ...GATE_OWNERS,
  exact("worker/container/Dockerfile"),
  exact("worker/container/scotty-codex-session.mjs"),
  ...CONTAINER_SOURCE_INPUTS,
  tree("worker/src/credentials"),
  tree("worker/src/runtime-cli"),
  tree("worker/src/sandbox"),
  tree("worker/src/session"),
  tree("worker/src/session-actor"),
  tree("worker/test/agent/codex"),
  exact("protocol/runtime-cli-manifest.ts"),
  exact("protocol/runtime-cli-pin.ts"),
  exact("protocol/runtime-image-compatibility.ts"),
  exact("scripts/check-codex-native-workflows.mjs"),
  exact("scripts/codex-session-supervisor.test.mjs"),
  exact(".github/workflows/release-cli.yml"),
]);

const matches = (path, input) =>
  path === input.path || (input.tree && path.startsWith(`${input.path}/`));

const matchingPaths = (paths, inputs) =>
  paths.filter((path) => inputs.some((input) => matches(path, input)));

export const classifyCiPaths = (paths) => {
  const changedPaths = [...new Set(paths.map((path) => path.replaceAll("\\", "/")))];
  const reasons = {
    cli_clean_room: matchingPaths(changedPaths, CLEAN_ROOM_CLI_INPUTS),
    cli_standalone: matchingPaths(changedPaths, STANDALONE_INPUTS),
    container_image: matchingPaths(changedPaths, FINAL_IMAGE_INPUTS),
    codex_native: matchingPaths(changedPaths, CODEX_NATIVE_INPUTS),
  };
  return {
    cli_clean_room: reasons.cli_clean_room.length > 0,
    cli_standalone: reasons.cli_standalone.length > 0,
    container_image: reasons.container_image.length > 0,
    codex_native: reasons.codex_native.length > 0,
    reasons,
  };
};

export const detectChangedPaths = (base, head, execute = spawnSync) => {
  if (!/^[0-9a-f]{40}$/u.test(base) || !/^[0-9a-f]{40}$/u.test(head)) {
    throw new Error("CI path detection requires full base and head commit SHAs");
  }
  const result = execute(
    "git",
    ["diff", "--name-only", "--no-renames", "--diff-filter=ACDMRTUXB", base, head, "--"],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`git diff failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  const paths = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .filter(Boolean);
  if (base !== head && paths.length === 0) throw new Error("git diff returned no changed paths");
  return paths;
};

const allEnabled = (reason) => ({
  cli_clean_room: true,
  cli_standalone: true,
  container_image: true,
  codex_native: true,
  reasons: {
    cli_clean_room: [reason],
    cli_standalone: [reason],
    container_image: [reason],
    codex_native: [reason],
  },
});

const writeOutputs = (decision, outputPath) => {
  const lines = ["cli_clean_room", "cli_standalone", "container_image", "codex_native"].map(
    (name) => `${name}=${String(decision[name])}`,
  );
  lines.push(`decision_json=${JSON.stringify(decision)}`);
  if (outputPath) appendFileSync(outputPath, `${lines.join("\n")}\n`);
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const baseIndex = process.argv.indexOf("--base");
  const headIndex = process.argv.indexOf("--head");
  let decision;
  try {
    const paths = detectChangedPaths(process.argv[baseIndex + 1], process.argv[headIndex + 1]);
    decision = classifyCiPaths(paths);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::warning::CI path detection failed open: ${detail}\n`);
    decision = allEnabled(`fail-open: ${detail}`);
  }
  writeOutputs(decision, process.env.GITHUB_OUTPUT);
}
