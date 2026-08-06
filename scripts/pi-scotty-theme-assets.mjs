import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const PI_CODING_AGENT_VERSION = "0.84.0";
export const PI_THEME_FILES = ["dark.json", "light.json"];

export const resolvePiCodingAgentPackage = async () => {
  const entry = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const packageDirectory = resolve(dirname(entry.pathname), "..");
  const packageJsonPath = join(packageDirectory, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.version !== PI_CODING_AGENT_VERSION)
    throw new Error(
      `@earendil-works/pi-coding-agent must be exactly ${PI_CODING_AGENT_VERSION}; found ${packageJson.version ?? "unknown"}`,
    );
  return {
    packageDirectory,
    themeDirectory: join(packageDirectory, "dist", "modes", "interactive", "theme"),
  };
};

export const copyPiScottyThemeAssets = async (binaryDirectory) => {
  const { themeDirectory } = await resolvePiCodingAgentPackage();
  const destination = join(binaryDirectory, "theme");
  await mkdir(destination, { recursive: true });
  for (const file of PI_THEME_FILES)
    await copyFile(join(themeDirectory, file), join(destination, file));
  return destination;
};
