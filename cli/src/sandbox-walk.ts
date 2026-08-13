import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Effect } from "effect";
import {
  compareUtf8,
  isExcludedBasename,
  isSafeBundlePath,
  sandboxBundleTooLarge,
  sandboxSourceInvalid,
  sha256Bytes,
  type SandboxFileModeClass,
} from "./sandbox-bundle";

export interface SandboxWalkLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
}

export interface WalkedSandboxFile {
  readonly path: string;
  readonly size: number;
  readonly modeClass: SandboxFileModeClass;
  readonly digest: string;
  readonly bytes: Uint8Array;
}

export interface SandboxWalkOptions extends SandboxWalkLimits {
  readonly includeNodeModules: boolean;
  readonly skipNodeModulesBin: boolean;
  readonly executableScripts: boolean;
}

const openFlags =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

const inodeKey = (metadata: Stats): string => `${metadata.dev}:${metadata.ino}`;

const staysInsideRoot = (root: string, candidate: string): boolean => {
  const base = resolve(root);
  const resolved = resolve(candidate);
  return resolved === base || resolved.startsWith(`${base}${sep}`);
};

const skipRelativePath = (relative: string, options: SandboxWalkOptions): boolean => {
  if (relative === "node_modules" || relative.startsWith("node_modules/")) {
    if (!options.includeNodeModules) return true;
    if (
      options.skipNodeModulesBin &&
      (relative === "node_modules/.bin" || relative.startsWith("node_modules/.bin/"))
    )
      return true;
  }
  const base = relative.includes("/") ? relative.slice(relative.lastIndexOf("/") + 1) : relative;
  return isExcludedBasename(base);
};

const modeClassFor = (
  relative: string,
  metadata: Stats,
  options: SandboxWalkOptions,
): SandboxFileModeClass => {
  if ((metadata.mode & 0o111) !== 0) return "executable";
  if (options.executableScripts && (relative === "scripts" || relative.startsWith("scripts/")))
    return "executable";
  return "regular";
};

const readRegularFile = Effect.fnUntraced(function* (
  absolute: string,
  relative: string,
  expected: Stats,
  options: SandboxWalkOptions,
) {
  if (expected.nlink > 1)
    return yield* sandboxSourceInvalid(
      "Sandbox sources must not contain hard links",
      `Rejected ${relative}.`,
    );
  if (expected.size > options.maxFileBytes)
    return yield* sandboxBundleTooLarge(
      "Sandbox source file exceeds the per-file size limit",
      `Rejected ${relative}.`,
    );
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(absolute, openFlags),
      catch: () =>
        sandboxSourceInvalid("Could not read a sandbox source file", `Checked ${relative}.`),
    }),
    (file) =>
      Effect.gen(function* () {
        const opened = yield* Effect.tryPromise({
          try: () => file.stat(),
          catch: () =>
            sandboxSourceInvalid("Could not stat a sandbox source file", `Checked ${relative}.`),
        });
        if (opened.isSymbolicLink() || !opened.isFile())
          return yield* sandboxSourceInvalid(
            "Sandbox sources must contain ordinary files and directories only",
            `Rejected ${relative}.`,
          );
        if (opened.dev !== expected.dev || opened.ino !== expected.ino)
          return yield* sandboxSourceInvalid(
            "Sandbox source file changed during read",
            `Rejected ${relative}.`,
          );
        if (opened.nlink > 1)
          return yield* sandboxSourceInvalid(
            "Sandbox sources must not contain hard links",
            `Rejected ${relative}.`,
          );
        if (opened.size > options.maxFileBytes)
          return yield* sandboxBundleTooLarge(
            "Sandbox source file exceeds the per-file size limit",
            `Rejected ${relative}.`,
          );
        const bytes = yield* Effect.tryPromise({
          try: () => file.readFile(),
          catch: () =>
            sandboxSourceInvalid("Could not read a sandbox source file", `Checked ${relative}.`),
        });
        if (bytes.byteLength !== opened.size)
          return yield* sandboxSourceInvalid(
            "Sandbox source file changed during read",
            `Rejected ${relative}.`,
          );
        return {
          path: relative,
          size: opened.size,
          modeClass: modeClassFor(relative, opened, options),
          digest: sha256Bytes(bytes),
          bytes,
        } satisfies WalkedSandboxFile;
      }),
    (file) => Effect.promise(() => file.close()),
  );
});

export const walkSandboxTree = Effect.fnUntraced(function* (
  root: string,
  options: SandboxWalkOptions,
) {
  const files: WalkedSandboxFile[] = [];
  const seenInodes = new Set<string>();
  let totalBytes = 0;
  const queue = [""];
  while (true) {
    const relative = queue.pop();
    if (relative === undefined) break;
    const absolute = relative.length === 0 ? root : join(root, ...relative.split("/"));
    if (!staysInsideRoot(root, absolute))
      return yield* sandboxSourceInvalid(
        "Sandbox source path escaped its configured root",
        `Rejected ${relative || "."}.`,
      );
    const metadata = yield* Effect.tryPromise({
      try: () => lstat(absolute),
      catch: () =>
        sandboxSourceInvalid(
          "Could not read a sandbox source path",
          `Checked ${relative || root}.`,
        ),
    });
    if (metadata.isSymbolicLink())
      return yield* sandboxSourceInvalid(
        "Sandbox sources must not contain symlinks",
        `Rejected ${relative || root}.`,
      );
    if (relative.length === 0) {
      if (!metadata.isDirectory())
        return yield* sandboxSourceInvalid(
          "Sandbox source must be a directory",
          `Checked ${root}.`,
        );
    } else {
      if (!isSafeBundlePath(relative))
        return yield* sandboxSourceInvalid(
          "Sandbox source contains an unsafe relative path",
          `Rejected ${relative}.`,
        );
      if (skipRelativePath(relative, options)) continue;
      if (seenInodes.has(inodeKey(metadata)))
        return yield* sandboxSourceInvalid(
          "Sandbox sources must not contain hard links",
          `Rejected ${relative}.`,
        );
      seenInodes.add(inodeKey(metadata));
    }
    if (metadata.isDirectory()) {
      const entries = yield* Effect.tryPromise({
        try: () => readdir(absolute, { withFileTypes: true }),
        catch: () =>
          sandboxSourceInvalid(
            "Could not list a sandbox source directory",
            `Checked ${relative || root}.`,
          ),
      });
      const names = entries.map((entry) => entry.name).sort(compareUtf8);
      for (const name of names) {
        if (name.includes("\0"))
          return yield* sandboxSourceInvalid(
            "Sandbox source contains an unsafe relative path",
            `Rejected ${name}.`,
          );
        queue.push(relative.length === 0 ? name : `${relative}/${name}`);
      }
      continue;
    }
    if (!metadata.isFile())
      return yield* sandboxSourceInvalid(
        "Sandbox sources must contain ordinary files and directories only",
        `Rejected ${relative}.`,
      );
    if (files.length >= options.maxFiles)
      return yield* sandboxBundleTooLarge(
        "Sandbox source exceeds the file-count limit",
        `Checked ${root}.`,
      );
    const file = yield* readRegularFile(absolute, relative, metadata, options);
    if (totalBytes + file.size > options.maxTotalBytes)
      return yield* sandboxBundleTooLarge(
        "Sandbox source exceeds the total size limit",
        `Checked ${root}.`,
      );
    totalBytes += file.size;
    files.push(file);
  }
  return files;
});
