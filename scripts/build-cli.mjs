import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOYMENT_INPUTS } from "../cli/src/deployment-inputs.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = join(root, ".scotty-build");
const archivePath = join(buildDirectory, "scotty-deployment.tar.gz");
const entryPath = join(buildDirectory, "standalone.ts");
const output = resolve(process.argv[2] ?? join(root, "dist", "scotty"));
const compileTarget = process.env.SCOTTY_COMPILE_TARGET;

async function collect(path, files) {
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await collect(child, files);
    else if (entry.isFile()) files[relative(root, child).replaceAll("\\", "/")] = Bun.file(child);
  }
}

await rm(buildDirectory, { recursive: true, force: true });
await mkdir(buildDirectory, { recursive: true });
const files = {};
for (const input of DEPLOYMENT_INPUTS) {
  const path = join(root, input);
  const entry = Bun.file(path);
  if (await entry.exists()) files[input] = entry;
  else await collect(path, files);
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
