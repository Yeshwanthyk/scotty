// Builds a release from this checkout: the Worker bundle, the web app's files and a manifest
// naming the pinned image. The deployer uploads a release as it is; it builds nothing.
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import cloudflareRolldown from "@alchemy.run/cloudflare-runtime/rolldown";
import { rolldown } from "rolldown";
import { supervisorVersion } from "../protocol/supervisor.ts";
import { version } from "../src/version.ts";
import { compatibilityDate, type Release } from "./deployer.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

export const buildRelease = async (dir: string) => {
  await rm(dir, { recursive: true, force: true });
  for (const entry of [
    { input: "deploy/entry.js", directory: "worker" },
    { input: "e2e/mcp-server-entry.js", directory: "mcp-oauth-test" },
  ]) {
    const bundle = await rolldown({
      input: join(root, entry.input),
      // Native modules that dev tooling references behind runtime guards.
      external: ["lightningcss", "fsevents"],
      cwd: root,
      plugins: [cloudflareRolldown({ compatibilityDate, compatibilityFlags: [] })],
      checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
      transform: { define: { "globalThis.__ALCHEMY_RUNTIME__": "true" } },
    });
    try {
      await bundle.write({
        format: "esm",
        minify: true,
        keepNames: true,
        codeSplitting: false,
        dir: join(dir, entry.directory),
        entryFileNames: "entry.js",
      });
    } finally {
      await bundle.close();
    }
  }
  // ui/dist/server is the prerender's own build, not something the browser loads.
  const ui = join(root, "ui/dist");
  await cp(ui, join(dir, "assets"), {
    recursive: true,
    filter: (path) => path !== join(ui, "server"),
  });
  const release: Release = {
    version,
    image: (await readFile(join(root, "container/image.digest"), "utf8")).trim(),
    supervisor: supervisorVersion,
  };
  await writeFile(join(dir, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
};
