import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
describe("pinned Task 4 contracts", () => {
  it("pairs the Sandbox image, Codex minor, and CLI build context", async () => {
    const dockerfile = await readFile(new URL("worker/container/Dockerfile", root), "utf8");

    expect(dockerfile).toContain(
      "cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe",
    );
    expect(dockerfile).not.toContain("ARG CODEX_VERSION=");
    expect(dockerfile).not.toContain("@openai/codex");
    expect(dockerfile).not.toContain("AGENT_BROWSER");
    expect(dockerfile).not.toContain("agent-browser");
    expect(dockerfile).not.toMatch(/(?:TOKEN|SECRET|PASSWORD)=\S+/);
  });
});
