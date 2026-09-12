import { lstat, realpath } from "node:fs/promises";
import { join, parse as parsePath, resolve } from "node:path";
import { Effect, Option, Schema } from "effect";
import { CliError, EXIT } from "./core";

export type SandboxBundleRoots = {
  readonly skills: ReadonlyArray<string>;
  readonly packages: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  readonly extensions: ReadonlyArray<string>;
};

type RootCategory = keyof SandboxBundleRoots;

const LocalRootPath = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length > 0 &&
      value.trim() === value &&
      !value.includes("\0") &&
      !value.includes("$") &&
      !value.includes("{{") &&
      !value.includes("}}") &&
      !/%[A-Za-z_][A-Za-z0-9_]*%/u.test(value) &&
      (!value.startsWith("~") || value === "~" || value.startsWith("~/")),
    { expected: "a local source root without unresolved placeholders" },
  ),
);
const decodeLocalRoot = Schema.decodeUnknownOption(LocalRootPath);

const invalidRoot = (category: RootCategory): CliError =>
  new CliError(
    "sandbox_source_invalid",
    `Invalid ${category} root`,
    "Use an existing, non-symlinked directory outside the filesystem or home root.",
    EXIT.USAGE,
  );

const resolveRoot = Effect.fnUntraced(function* (
  source: string,
  category: RootCategory,
  home: string,
  cwd: string,
) {
  if (Option.isNone(decodeLocalRoot(source)))
    return yield* new CliError(
      "sandbox_source_invalid",
      `Invalid ${category} root`,
      `Choose a local directory without placeholders; checked ${source}.`,
      EXIT.USAGE,
    );
  const expanded =
    source === "~" ? home : source.startsWith("~/") ? join(home, source.slice(2)) : source;
  const resolved = resolve(cwd, expanded);
  if (resolved === parsePath(resolved).root || resolved === resolve(home))
    return yield* invalidRoot(category);
  const metadata = yield* Effect.tryPromise({
    try: () => lstat(resolved),
    catch: () => invalidRoot(category),
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return yield* invalidRoot(category);
  const canonical = yield* Effect.tryPromise({
    try: () => realpath(resolved),
    catch: () => invalidRoot(category),
  });
  if (canonical === parsePath(canonical).root || canonical === resolve(home))
    return yield* invalidRoot(category);
  return canonical;
});

export const resolveSandboxBundleRoots = Effect.fnUntraced(function* (
  input: {
    readonly home: string;
    readonly cwd: string;
  } & SandboxBundleRoots,
) {
  const load = Effect.fnUntraced(function* (category: RootCategory) {
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const source of input[category]) {
      const root = yield* resolveRoot(source, category, input.home, input.cwd);
      if (seen.has(root)) return yield* invalidRoot(category);
      seen.add(root);
      roots.push(root);
    }
    return roots;
  });
  return {
    skills: yield* load("skills"),
    packages: yield* load("packages"),
    tools: yield* load("tools"),
    extensions: yield* load("extensions"),
  } satisfies SandboxBundleRoots;
});
