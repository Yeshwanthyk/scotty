import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOYMENT_INPUTS, listPackagedFiles } from "../cli/src/deployment-packaging.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = join(root, ".scotty-build");
const archivePath = join(buildDirectory, "scotty-deployment.tar.gz");
const entryPath = join(buildDirectory, "standalone.ts");
const output = resolve(process.argv[2] ?? join(root, "dist", "scotty"));
const compileTarget = process.env.SCOTTY_COMPILE_TARGET;

await rm(buildDirectory, { recursive: true, force: true });
await mkdir(buildDirectory, { recursive: true });
const files = {};
for (const relativePath of await listPackagedFiles(root, DEPLOYMENT_INPUTS)) {
  files[relativePath] = Bun.file(join(root, relativePath));
}
await Bun.Archive.write(archivePath, files, { compress: "gzip", level: 9 });

const archiveImport = JSON.stringify(`./${relative(buildDirectory, archivePath)}`);
const cliImport = JSON.stringify(`../cli/scotty.ts`);
await Bun.write(
  entryPath,
  [
    `import ${archiveImport} with { type: "file" };`,
    `import { main } from ${cliImport};`,
    "process.exitCode = await main();",
    "",
  ].join("\n"),
);
await Bun.build({
  entrypoints: [entryPath],
  target: "bun",
  compile: {
    outfile: output,
    ...(compileTarget ? { target: compileTarget } : {}),
  },
  minify: true,
  sourcemap: "none",
});
await rm(buildDirectory, { recursive: true, force: true });
process.stdout.write(`${output}\n`);
