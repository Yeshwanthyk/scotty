import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLOUDFLARE_BINDING_TOPOLOGY,
  EXCLUDED_TOPOLOGY_DO_FIELDS,
  REQUIRED_TOPOLOGY_DO_FIELDS,
  REQUIRED_TOPOLOGY_R2_FIELDS,
} from "./cloudflare-topology-data.mjs";

export const WRANGLER_CONFIG_PATH = "worker/wrangler.jsonc";
export const WRANGLER_BINDINGS_INSTALLATION_NAME = "local";
export const EXCLUDED_RUNNER_BINDING = "RUNNERS";
export const EXCLUDED_RUNNER_CLASS = "ScottyRunner";

export {
  CLOUDFLARE_BINDING_TOPOLOGY,
  EXCLUDED_TOPOLOGY_DO_FIELDS,
  REQUIRED_TOPOLOGY_DO_FIELDS,
  REQUIRED_TOPOLOGY_R2_FIELDS,
};

export const parseJsonc = (source) => {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:\\])\/\/.*$/gmu, "$1");
  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/gu, "$1"));
};

const requireString = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Wrangler binding check failed: ${label} must be a string`);
  }
  return value;
};

export const requiredWranglerBindingSubset = (topology) => ({
  durableObjects: REQUIRED_TOPOLOGY_DO_FIELDS.map((field) => ({
    bindingName: requireString(topology[field]?.bindingName, `${field}.bindingName`),
    className: requireString(topology[field]?.className, `${field}.className`),
  })),
  kvBindings: [requireString(topology.kv?.bindingName, "kv.bindingName")],
  r2Bindings: REQUIRED_TOPOLOGY_R2_FIELDS.map((field) =>
    requireString(topology[field]?.bindingName, `${field}.bindingName`),
  ),
});

export const collectWranglerBindings = (config) => ({
  durableObjects: (config.durable_objects?.bindings ?? []).map((binding) => ({
    bindingName: binding.name,
    className: binding.class_name,
  })),
  kvBindings: (config.kv_namespaces ?? []).map((namespace) => namespace.binding),
  r2Bindings: (config.r2_buckets ?? []).map((bucket) => bucket.binding),
});

const missingLabels = (actual, required) => {
  const missing = [];
  for (const expected of required.durableObjects) {
    if (
      !actual.durableObjects.some(
        (entry) =>
          entry.bindingName === expected.bindingName && entry.className === expected.className,
      )
    ) {
      missing.push(`durable object ${expected.bindingName} (${expected.className})`);
    }
  }
  for (const bindingName of required.kvBindings) {
    if (!actual.kvBindings.includes(bindingName)) missing.push(`KV ${bindingName}`);
  }
  for (const bindingName of required.r2Bindings) {
    if (!actual.r2Bindings.includes(bindingName)) missing.push(`R2 ${bindingName}`);
  }
  return missing;
};

export const assertWranglerBindingsCoverTopology = ({ wrangler, topology }) => {
  const runnerBinding = topology.runnerDurableObject?.bindingName;
  const runnerClass = topology.runnerDurableObject?.className;
  if (runnerBinding !== EXCLUDED_RUNNER_BINDING || runnerClass !== EXCLUDED_RUNNER_CLASS) {
    throw new Error(
      `Wrangler binding check failed: topology runnerDurableObject must remain the excluded ${EXCLUDED_RUNNER_BINDING} / ${EXCLUDED_RUNNER_CLASS} binding`,
    );
  }

  const required = requiredWranglerBindingSubset(topology);
  if (
    required.durableObjects.some(
      (entry) =>
        entry.bindingName === EXCLUDED_RUNNER_BINDING || entry.className === EXCLUDED_RUNNER_CLASS,
    )
  ) {
    throw new Error(
      `Wrangler binding check failed: required subset must not include the runner worker ${EXCLUDED_RUNNER_BINDING} binding`,
    );
  }

  const actual = collectWranglerBindings(wrangler);
  const missing = missingLabels(actual, required);
  if (missing.length > 0) {
    throw new Error(
      `Wrangler binding check failed: ${WRANGLER_CONFIG_PATH} is missing required topology bindings: ${missing.join(", ")}`,
    );
  }

  return { required, actual };
};

export const checkWranglerBindings = ({
  root = process.cwd(),
  read = (relativePath) => readFileSync(join(root, relativePath), "utf8"),
} = {}) => {
  const wrangler = parseJsonc(read(WRANGLER_CONFIG_PATH));
  return assertWranglerBindingsCoverTopology({
    wrangler,
    topology: CLOUDFLARE_BINDING_TOPOLOGY,
  });
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = checkWranglerBindings();
  console.log(
    `Verified ${WRANGLER_CONFIG_PATH} covers the ${WRANGLER_BINDINGS_INSTALLATION_NAME} topology subset: ${result.required.durableObjects.length} Durable Object classes, ${result.required.r2Bindings.length} R2 buckets, and KV ${result.required.kvBindings.join(", ")}.`,
  );
}
