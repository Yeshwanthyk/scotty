const binding = (logicalId, bindingName, className) =>
  Object.freeze({ logicalId, bindingName, ...(className === undefined ? {} : { className }) });

export const CLOUDFLARE_BINDING_TOPOLOGY = Object.freeze({
  durableObject: binding("Sandbox", "SANDBOX", "ScottySandbox"),
  authDurableObject: binding("AuthRegistry", "AUTH", "ScottyAuthRegistry"),
  runnerRegistryDurableObject: binding("RunnerRegistry", "RUNNER_REGISTRY", "ScottyRunnerRegistry"),
  runnerDurableObject: binding("Runner", "RUNNERS", "ScottyRunner"),
  sandboxConfigDurableObject: binding("SandboxConfig", "SANDBOX_CONFIG", "ScottySandboxConfig"),
  credentialRegistryDurableObject: binding(
    "CredentialRegistry",
    "CREDENTIALS",
    "ScottyCredentialRegistry",
  ),
  kv: binding("SessionsProjection", "SESSIONS"),
  r2: binding("BackupBucket", "BACKUP_BUCKET"),
  artifactR2: binding("ArtifactBucket", "ARTIFACT_BUCKET"),
  sandboxBundleR2: binding("SandboxBundleBucket", "SANDBOX_BUNDLE_BUCKET"),
});

export const REQUIRED_TOPOLOGY_DO_FIELDS = Object.freeze([
  "durableObject",
  "authDurableObject",
  "runnerRegistryDurableObject",
  "sandboxConfigDurableObject",
  "credentialRegistryDurableObject",
]);
export const EXCLUDED_TOPOLOGY_DO_FIELDS = Object.freeze(["runnerDurableObject"]);
export const REQUIRED_TOPOLOGY_R2_FIELDS = Object.freeze(["r2", "artifactR2", "sandboxBundleR2"]);
