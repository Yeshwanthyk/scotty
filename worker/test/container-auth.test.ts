import { assert, describe, it } from "@effect/vitest";
import { agentEnv, piAuthJson } from "../src/container-auth";
import {
  githubManagedHandle,
  managedPiAccessToken,
  piAuthJson as managedPiAuthJson,
  sessionRuntimeCredentials,
} from "../src/managed-credentials";
import type { CredentialGrant } from "../../protocol/credentials";

type ProjectedPiAuth = {
  readonly openai: { readonly type: "api_key"; readonly key: string };
  readonly "openai-codex": {
    readonly type: "oauth";
    readonly access: string;
    readonly refresh: string;
    readonly expires: number;
    readonly accountId: string;
  };
};
const SESSION_ID = "a0b1c2d3e4f5";
const grants: ReadonlyArray<CredentialGrant> = [
  {
    name: "codex",
    kind: "pi-auth",
    versionRef: "version-a",
    handleSlots: [
      { provider: "openai", slot: "api-key" },
      { provider: "openai-codex", slot: "access" },
      { provider: "openai-codex", slot: "refresh" },
    ],
  },
  {
    name: "github",
    kind: "github-cli",
    versionRef: "version-b",
    handleSlots: [{ provider: "github", slot: "git-https" }],
  },
];
const credentials = sessionRuntimeCredentials(grants);

// Keep this assertion close to the ContainerAuth boundary: native files only receive projections.
describe("container managed credential projection", () => {
  it("projects fixed handles into Pi auth and GitHub environment values", () => {
    const auth = JSON.parse(piAuthJson(credentials)) as ProjectedPiAuth;
    const apiKey = "scotty-managed://codex/openai/api-key";
    const access = "scotty-managed://codex/openai-codex/access";
    const refresh = "scotty-managed://codex/openai-codex/refresh";
    const github = "scotty-managed://github/github/git-https";

    assert.deepStrictEqual(auth.openai, { type: "api_key", key: apiKey });
    assert.deepStrictEqual(auth["openai-codex"], {
      type: "oauth",
      access: managedPiAccessToken(access),
      refresh,
      expires: 0,
      accountId: "scotty-managed",
    });
    assert.strictEqual(githubManagedHandle(grants), github);
    assert.strictEqual(agentEnv(SESSION_ID, credentials).GH_TOKEN, github);
    assert.ok(!JSON.stringify(auth).includes("plaintext"));
  });

  it("projects an empty grant selection without ambient credential fallbacks", () => {
    const empty = sessionRuntimeCredentials([]);
    assert.deepStrictEqual(JSON.parse(managedPiAuthJson(empty)), {});
    const env = agentEnv(SESSION_ID, empty);
    assert.strictEqual(env.GH_TOKEN, undefined);
  });
});
