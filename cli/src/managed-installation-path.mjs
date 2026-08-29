import { join } from "node:path";

export const managedInstallationPath = (home) =>
  join(home, ".config", "scotty", "installation.json");
