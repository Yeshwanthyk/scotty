import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const filesystemIdentity = (path) => {
  const realpath = realpathSync.native(path);
  const metadata = statSync(realpath, { bigint: true });
  return { realpath, device: metadata.dev, inode: metadata.ino };
};

export const isDirectRun = (importMetaUrl, argv1) => {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;

  let modulePath;
  try {
    const url = new URL(importMetaUrl);
    if (url.protocol !== "file:") return false;
    modulePath = fileURLToPath(url);
  } catch {
    return false;
  }

  try {
    const moduleIdentity = filesystemIdentity(modulePath);
    const entryIdentity = filesystemIdentity(argv1);
    if (moduleIdentity.inode !== 0n && entryIdentity.inode !== 0n) {
      return (
        moduleIdentity.device === entryIdentity.device &&
        moduleIdentity.inode === entryIdentity.inode
      );
    }
    const moduleRealpath =
      process.platform === "win32"
        ? moduleIdentity.realpath.toLowerCase()
        : moduleIdentity.realpath;
    const entryRealpath =
      process.platform === "win32" ? entryIdentity.realpath.toLowerCase() : entryIdentity.realpath;
    return moduleRealpath === entryRealpath;
  } catch {
    return false;
  }
};
