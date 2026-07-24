import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
type JsonObject = Record<string, unknown>;

async function readJson(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(new URL(path, root), "utf8")) as JsonObject;
}

describe("pinned Task 4 contracts", () => {
  it("pins the selected toolchain and runtime packages exactly", async () => {
    const rootPackage = await readJson("package.json");
    const workerPackage = await readJson("worker/package.json");

    expect(rootPackage.devDependencies).toMatchObject({
      "@effect/vitest": "4.0.0-beta.99",
      typescript: "7.0.2",
      vitest: "4.1.10",
      wrangler: "4.112.0",
    });
    expect(rootPackage.dependencies).toMatchObject({
      "@effect/platform-node": "4.0.0-beta.99",
      alchemy: "2.0.0-beta.63",
      effect: "4.0.0-beta.99",
    });
    expect(workerPackage.dependencies).toEqual({
      "@cloudflare/containers": "0.3.5",
      "@cloudflare/sandbox": "0.12.3",
      effect: "4.0.0-beta.99",
      "ghostty-web": "0.4.0",
      hono: "4.12.31",
      "qrcode-generator": "1.4.4",
    });
  });

  it("pairs the Sandbox package, container image, and Codex minor", async () => {
    const dockerfile = await readFile(new URL("worker/container/Dockerfile", root), "utf8");

    expect(dockerfile).toContain("cloudflare/sandbox:0.12.3@sha256:");
    expect(dockerfile).toContain("ARG CODEX_VERSION=0.144.6");
    expect(dockerfile).not.toContain("AGENT_BROWSER");
    expect(dockerfile).not.toContain("agent-browser");
    expect(dockerfile).not.toMatch(/(?:TOKEN|SECRET|PASSWORD)=\S+/);
  });

  it("uses the installed BerkeleyMono Nerd Font family with readable terminal defaults", async () => {
    const terminalHtml = await readFile(new URL("worker/public/terminal.html", root), "utf8");

    expect(terminalHtml).toMatch(
      /"BerkeleyMono Nerd Font", "Berkeley Mono", "SFMono-Regular", "Cascadia Mono"/,
    );
    expect(terminalHtml).toContain('const mobileLayout = matchMedia("(max-width: 560px)")');
    expect(terminalHtml).toContain('const fontSizeStorageKey = "scotty-terminal-font-size-v2"');
    expect(terminalHtml).toMatch(
      /terminalFontSize\(localStorage\.getItem\(fontSizeStorageKey\), 15\)/,
    );
    expect(terminalHtml).toContain('foreground: "#e8f0f3"');
    expect(terminalHtml).toContain('brightBlack: "#7d8d98"');
  });

  it("selects RPC transport and the expected runtime bindings", async () => {
    const config = await readFile(new URL("worker/wrangler.jsonc", root), "utf8");

    expect(config).toContain('"SANDBOX_TRANSPORT": "rpc"');
    expect(config).toContain('"instance_type": "standard-2"');
    expect(config).toContain('"binding": "BACKUP_BUCKET"');
    expect(config).toContain('"binding": "SESSIONS"');
  });
});
