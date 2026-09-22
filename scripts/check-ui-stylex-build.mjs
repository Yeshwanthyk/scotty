import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(projectRoot, "worker/public/app");
const shellPath = join(outputRoot, "_shell.html");

const readLocalStylesheet = async (href) => {
  const assetPath = resolve(outputRoot, href.replace(/^\/+/, ""));
  const outputPrefix = `${outputRoot}${sep}`;
  if (!assetPath.startsWith(outputPrefix)) {
    throw new Error(`UI shell stylesheet points outside the build output: ${href}`);
  }
  return { href, path: assetPath, source: await readFile(assetPath, "utf8") };
};

const verifyStylexBuild = async () => {
  const shell = await readFile(shellPath, "utf8");
  const stylesheetHrefs = Array.from(
    shell.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/giu),
    (match) => match[1],
  ).filter((href) => href?.startsWith("/"));

  if (stylesheetHrefs.length === 0) {
    throw new Error("UI shell does not eagerly link any local stylesheets");
  }

  const eagerStylesheets = await Promise.all(stylesheetHrefs.map(readLocalStylesheet));
  const eagerCss = eagerStylesheets.map(({ source }) => source).join("\n");
  const bodyTag = shell.match(/<body\b[^>]*>/iu)?.[0];
  const bodyClasses = bodyTag
    ?.match(/\bclass=["']([^"']+)["']/iu)?.[1]
    ?.split(/\s+/u)
    .filter((className) => /^x[a-z0-9]+$/u.test(className));

  if (!bodyClasses || bodyClasses.length === 0) {
    throw new Error("UI shell body does not contain compiled StyleX classes");
  }

  const missingBodyClasses = bodyClasses.filter(
    (className) => !new RegExp(`\\.${className}(?![a-zA-Z0-9_-])`, "u").test(eagerCss),
  );
  if (missingBodyClasses.length > 0) {
    throw new Error(
      `UI shell StyleX classes are missing from eager CSS: ${missingBodyClasses.join(", ")}`,
    );
  }

  if (!/@layer\s+priority[1-9]\b/u.test(eagerCss) || !/--x[a-z0-9]+\s*:/u.test(eagerCss)) {
    throw new Error("UI shell eager CSS is missing compiled StyleX rules or theme variables");
  }

  const assetsRoot = join(outputRoot, "assets");
  const eagerPaths = new Set(eagerStylesheets.map(({ path }) => path));
  const cssAssets = (await readdir(assetsRoot, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".css"),
  );
  const lazyStylexAssets = [];
  for (const asset of cssAssets) {
    const assetPath = join(assetsRoot, asset.name);
    if (eagerPaths.has(assetPath)) continue;
    const source = await readFile(assetPath, "utf8");
    if (/@layer\s+priority[1-9]\b/u.test(source) || /--x[a-z0-9]+\s*:/u.test(source)) {
      lazyStylexAssets.push(relative(outputRoot, assetPath));
    }
  }
  if (lazyStylexAssets.length > 0) {
    throw new Error(
      `Compiled StyleX CSS is stranded in lazy assets: ${lazyStylexAssets.join(", ")}`,
    );
  }

  return {
    bodyClasses,
    stylesheets: eagerStylesheets.map(({ href }) => href),
  };
};

const result = await verifyStylexBuild();
process.stdout.write(
  `Verified ${result.bodyClasses.length} shell StyleX classes in eager CSS (${result.stylesheets.join(", ")})\n`,
);
