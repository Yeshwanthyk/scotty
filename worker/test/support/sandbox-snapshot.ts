import { createDeterministicTarGz } from "../../../cli/src/sandbox-archive";
import {
  encodeDeployedSnapshotJson,
  sha256Bytes,
  sha256Text,
} from "../../../cli/src/sandbox-bundle";
import type { DeployedSnapshot } from "../../../protocol/sandbox-config";
import type { SandboxConfigStatus } from "../../src/sandbox-config-contracts";

export const TEST_SANDBOX_PLUGIN_BUNDLE = createDeterministicTarGz([
  {
    path: "manifest.json",
    type: "file",
    modeClass: "regular",
    bytes: new TextEncoder().encode('{"schemaVersion":1,"plugins":[]}\n'),
  },
]).archive;

export const TEST_SANDBOX_PLUGIN_BUNDLE_DIGEST = sha256Bytes(TEST_SANDBOX_PLUGIN_BUNDLE);

export const testSandboxSnapshot = (revision: number) => {
  const snapshot: DeployedSnapshot = {
    schemaVersion: 1,
    installationName: "home",
    revision,
    configDigest: sha256Text("test-config"),
    pluginBundleDigest: TEST_SANDBOX_PLUGIN_BUNDLE_DIGEST,
    pi: {
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-sol",
      defaultThinkingLevel: "medium",
    },
    plugins: [],
    sandboxSetup: { piExtensions: [], skills: [], sandboxTools: [] },
  };
  const snapshotJson = encodeDeployedSnapshotJson(snapshot);
  return { revision, snapshotJson, digest: sha256Text(snapshotJson) };
};

export const TEST_SANDBOX_SNAPSHOT = testSandboxSnapshot(1);

export const testSandboxConfigStatus = (revision: number): SandboxConfigStatus => {
  const prepared = testSandboxSnapshot(revision);
  return {
    schemaVersion: 1,
    installationName: "home",
    cloudflareAccountId: "account-1",
    revision,
    activeSnapshot: {
      revision,
      snapshotDigest: prepared.digest,
      configDigest: sha256Text("test-config"),
      syncId: `sync-${revision}`,
      activatedAt: "2026-08-24T00:00:00.000Z",
    },
  };
};
