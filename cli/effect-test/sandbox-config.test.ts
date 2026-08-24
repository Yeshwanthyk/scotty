import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";
import type { ScottyConfig } from "../../protocol/sandbox-config";
import {
  decodeSandboxConfigText,
  encodeSandboxConfigJson,
  sandboxConfigPath,
} from "../src/sandbox-config.ts";
import {
  installationStatePath,
  operationStatePath,
  rootCredentialPath,
} from "../src/local-paths.ts";

const config = (): ScottyConfig => ({
  schemaVersion: 1,
  installation: { name: "home", cloudflareAccountId: "account-1" },
  pi: {
    defaultProvider: "openai",
    defaultModel: "gpt-5.6-sol",
    defaultThinkingLevel: "medium",
  },
  plugins: [
    {
      id: "cloudflare",
      type: "compute-provider",
      enabled: true,
      source: { kind: "builtin", name: "cloudflare" },
    },
  ],
  sandboxSetup: { piExtensions: [], skills: [], sandboxTools: [] },
});

describe("Scotty configuration schema", () => {
  it("resolves only the XDG config path and keeps operational files in XDG state", () => {
    const env = {
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_STATE_HOME: "/xdg/state",
    };
    assert.strictEqual(sandboxConfigPath("/home/test", env), "/xdg/config/scotty/config.json");
    assert.strictEqual(
      sandboxConfigPath("/home/test", {}),
      "/home/test/.config/scotty/config.json",
    );
    assert.strictEqual(
      sandboxConfigPath("/home/test", { XDG_CONFIG_HOME: "relative" }),
      "/home/test/.config/scotty/config.json",
    );
    assert.strictEqual(
      installationStatePath("/home/test", env),
      "/xdg/state/scotty/installation.json",
    );
    assert.strictEqual(rootCredentialPath("/home/test", env), "/xdg/state/scotty/credentials/root");
    assert.strictEqual(
      operationStatePath("/home/test", env, "sync.json"),
      "/xdg/state/scotty/operations/sync.json",
    );
  });

  it("strictly decodes the complete document and rejects excess fields", () => {
    const value = config();
    assert.deepStrictEqual(
      decodeSandboxConfigText(encodeSandboxConfigJson(value)),
      Result.succeed(value),
    );
    assert.ok(
      Result.isFailure(
        decodeSandboxConfigText(JSON.stringify({ ...value, legacy: { skills: [] } })),
      ),
    );
    assert.ok(
      Result.isFailure(
        decodeSandboxConfigText(
          JSON.stringify({
            ...value,
            plugins: [
              {
                ...value.plugins[0],
                source: { kind: "git", url: "https://example.test" },
              },
            ],
          }),
        ),
      ),
    );
    for (const excess of [
      { ...value, installation: { ...value.installation, profile: "legacy" } },
      { ...value, pi: { ...value.pi, retry: { provider: { timeoutMs: 1, jitter: true } } } },
      {
        ...value,
        plugins: [{ ...value.plugins[0], legacySource: "remote" }],
      },
      {
        ...value,
        plugins: [
          {
            ...value.plugins[0],
            source: { ...value.plugins[0]?.source, revision: "main" },
          },
        ],
      },
      { ...value, sandboxSetup: { ...value.sandboxSetup, packages: [] } },
    ])
      assert.ok(Result.isFailure(decodeSandboxConfigText(JSON.stringify(excess))));
  });

  it("preserves declared Plugin and setup order in encoded desired input", () => {
    const value: ScottyConfig = {
      ...config(),
      plugins: [
        {
          id: "zeta",
          type: "skill",
          enabled: false,
          source: { kind: "path", path: "/missing" },
        },
        ...config().plugins,
        {
          id: "alpha",
          type: "skill",
          enabled: false,
          source: { kind: "path", path: "/also-missing" },
        },
      ],
    };
    const decoded = decodeSandboxConfigText(encodeSandboxConfigJson(value));
    assert.ok(Result.isSuccess(decoded));
    assert.deepStrictEqual(
      decoded.success.plugins.map((plugin) => plugin.id),
      ["zeta", "cloudflare", "alpha"],
    );
  });
});
