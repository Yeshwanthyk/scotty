import {
  defaultCloudSettings,
  type CloudSettingsSnapshot,
} from "../../../protocol/settings/cloud-settings";
import type { RepositoryRegistryEntry } from "../../../protocol/settings/repository";
import type { CurrentPrincipal } from "../data/admin";
import type { CredentialStatus, ResourceSnapshot, SettingsResult } from "../data/settings";

const now = "2026-09-22T14:00:00.000Z";
const digest = "8e6f4b8f2c3d94c4a1c6223b46b63e4b53247c25465dc97c3f47fd36575b5f50";

export const settingsPreviewSnapshot: CloudSettingsSnapshot = {
  revision: 12,
  activeDigest: digest,
  settings: {
    ...defaultCloudSettings,
    customInstructions: "Prefer small, verified changes and preserve unrelated work.",
    environment: { FEATURE_CHANNEL: "preview", LOG_LEVEL: "info" },
  },
};

export const settingsPreviewRepositories: ReadonlyArray<RepositoryRegistryEntry> = [
  { repo: "scotty-dev/scotty", defaultBranch: "main", addedAt: now, lastUsedAt: now },
  { repo: "scotty-dev/perseus", defaultBranch: "main", addedAt: now, lastUsedAt: now },
];

export const settingsPreviewResources: ResourceSnapshot = {
  revision: 12,
  activeDigest: digest,
  items: [
    {
      kind: "skill",
      name: "release-check",
      shape: "directory",
      digest,
      files: [{ path: "SKILL.md", size: 2840, modeClass: "regular", digest }],
    },
    {
      kind: "extension",
      name: "session-tools.ts",
      shape: "file",
      digest,
      files: [{ path: "session-tools.ts", size: 1180, modeClass: "regular", digest }],
    },
  ],
};

export const settingsPreviewCredentials: ReadonlyArray<CredentialStatus> = [
  {
    name: "work-openai",
    kind: "pi-auth",
    scope: "global",
    configured: true,
    versionRef: "preview-openai-v3",
  },
  {
    name: "github-cli",
    kind: "github-cli",
    scope: "global",
    configured: true,
    versionRef: "preview-github-v2",
  },
];

export const settingsPreviewPrincipal: SettingsResult<CurrentPrincipal> = {
  ok: true,
  value: { role: "owner" },
};
