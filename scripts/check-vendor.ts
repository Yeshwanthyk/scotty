// Fails when vendor/ is not the source of the installed Effect and Alchemy.
// Every dependency in package.json that a vendored repo publishes must have the
// same version in package.json, in node_modules and in the vendored checkout,
// the checkout must be the commit this repository records, and AGENTS.md and
// docs/design.md must name the same versions.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

const root = join(import.meta.dirname, "..");
const vendored = [
  { dir: "vendor/effect", anchor: "effect", label: "Effect" },
  { dir: "vendor/alchemy", anchor: "alchemy", label: "Alchemy" },
] as const;
const versionDocs = ["AGENTS.md", "docs/design.md"];

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String),
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);
const readManifest = (path: string) =>
  Schema.decodeUnknownSync(Manifest)(readFileSync(path, "utf8"));

const git = (args: ReadonlyArray<string>) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const packageDirs = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
      return [];
    }
    const path = join(dir, entry.name);
    return existsSync(join(path, "package.json")) ? [path] : packageDirs(path);
  });

const problems: Array<string> = [];
const own = readManifest(join(root, "package.json"));
const declared = new Map(Object.entries({ ...own.dependencies, ...own.devDependencies }));

for (const { dir, anchor, label } of vendored) {
  const packages = join(root, dir, "packages");
  if (!existsSync(packages)) {
    problems.push(`${dir} is empty: run git submodule update --init ${dir}`);
    continue;
  }

  const recorded = git(["ls-files", "--stage", "--", dir]).split(/\s+/)[1];
  const checkedOut = git(["-C", dir, "rev-parse", "HEAD"]);
  if (recorded !== checkedOut) {
    problems.push(
      `${dir} is checked out at ${checkedOut}, but the repository records ${recorded}: run git submodule update ${dir}`,
    );
  }

  const published = new Map<string, string>();
  for (const path of packageDirs(packages)) {
    const manifest = readManifest(join(path, "package.json"));
    if (manifest.name !== undefined && manifest.version !== undefined) {
      published.set(manifest.name, manifest.version);
    }
  }

  const anchorVersion = declared.get(anchor);
  if (anchorVersion === undefined || !published.has(anchor)) {
    problems.push(`${dir} should publish ${anchor}, which package.json should depend on`);
    continue;
  }

  for (const [name, version] of declared) {
    const inVendor = published.get(name);
    if (inVendor === undefined) continue;
    if (inVendor !== version) {
      problems.push(`${name}: package.json has ${version}, ${dir} has ${inVendor}`);
    }
    const installedPath = join(root, "node_modules", name, "package.json");
    const installed = existsSync(installedPath) ? readManifest(installedPath).version : undefined;
    if (installed !== version) {
      problems.push(
        `${name}: package.json has ${version}, node_modules has ${installed ?? "nothing"}: run npm install`,
      );
    }
  }

  for (const doc of versionDocs) {
    if (!readFileSync(join(root, doc), "utf8").includes(`${label} \`${anchorVersion}\``)) {
      problems.push(`${doc} should name ${label} \`${anchorVersion}\``);
    }
  }
}

if (problems.length > 0) {
  console.error(`vendor/ does not match the installed versions:\n- ${problems.join("\n- ")}`);
  process.exitCode = 1;
}
