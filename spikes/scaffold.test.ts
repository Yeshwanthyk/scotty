import { readFile } from "node:fs/promises";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const PackageManifestSchema = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
type PackageManifest = typeof PackageManifestSchema.Type;
const decodePackageManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(PackageManifestSchema),
);

async function readPackageManifest(path: string): Promise<PackageManifest> {
  return decodePackageManifest(await readFile(new URL(path, root), "utf8"));
}

describe("pinned Task 4 contracts", () => {
  it("pins the selected toolchain and runtime packages exactly", async () => {
    const rootPackage = await readPackageManifest("package.json");
    const workerPackage = await readPackageManifest("worker/package.json");

    expect(rootPackage.devDependencies).toMatchObject({
      "@effect/vitest": "4.0.0-beta.103",
      typescript: "7.0.2",
      vitest: "4.1.10",
      wrangler: "4.112.0",
    });
    expect(rootPackage.dependencies).toMatchObject({
      "@effect/platform-node": "4.0.0-beta.103",
      alchemy: "2.0.0-beta.67",
      effect: "4.0.0-beta.103",
    });
    expect(workerPackage.dependencies).toEqual({
      "@cloudflare/containers": "0.3.5",
      "@cloudflare/sandbox": "0.12.3",
      effect: "4.0.0-beta.103",
      hono: "4.12.31",
      "qrcode-generator": "1.4.4",
    });
  });

  it("pairs the Sandbox image, Codex minor, and CLI build context", async () => {
    const dockerfile = await readFile(new URL("worker/container/Dockerfile", root), "utf8");
    const dockerignore = await readFile(new URL(".dockerignore", root), "utf8");

    expect(dockerfile).toContain("cloudflare/sandbox:0.12.3@sha256:");
    expect(dockerfile).not.toContain("ARG CODEX_VERSION=");
    expect(dockerfile).toContain("ARG GO_VERSION=1.26.1");
    expect(dockerfile).not.toContain("@openai/codex");
    expect(dockerfile).toContain("COPY protocol protocol");
    expect(dockerignore).toContain("!protocol/");
    expect(dockerignore).toContain("!protocol/**");
    expect(dockerignore).toContain("**/node_modules");
    expect(dockerignore).toContain("**/.git");
    expect(dockerfile).not.toContain("AGENT_BROWSER");
    expect(dockerfile).not.toContain("agent-browser");
    expect(dockerfile).not.toMatch(/(?:TOKEN|SECRET|PASSWORD)=\S+/);
  });

  it("selects RPC transport and the expected runtime bindings", async () => {
    const config = await readFile(new URL("worker/wrangler.jsonc", root), "utf8");

    expect(config).toContain('"SANDBOX_TRANSPORT": "rpc"');
    expect(config).toContain('"instance_type": "standard-2"');
    expect(config).toContain('"binding": "BACKUP_BUCKET"');
    expect(config).toContain('"binding": "SESSIONS"');
  });
});
