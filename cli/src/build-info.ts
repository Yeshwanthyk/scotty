import { basename } from "node:path";
import { VERSION } from "./core";
import { isDeploymentArchiveFileName } from "./deployment-packaging";

declare const SCOTTY_BUILD_COMMIT: string;
declare const SCOTTY_BUILD_DIRTY: boolean;

export const buildInfo = () => ({
  version: VERSION,
  commit: typeof SCOTTY_BUILD_COMMIT === "string" ? SCOTTY_BUILD_COMMIT : null,
  dirty: typeof SCOTTY_BUILD_DIRTY === "boolean" ? SCOTTY_BUILD_DIRTY : null,
  embeddedDeployment:
    typeof Bun !== "undefined" &&
    Bun.embeddedFiles.some((file) => {
      const name = Reflect.get(file, "name");
      return typeof name === "string" && isDeploymentArchiveFileName(basename(name));
    }),
});
