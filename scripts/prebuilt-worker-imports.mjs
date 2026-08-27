import { builtinModules } from "node:module";
import { parse } from "acorn";

const ALLOWED_IMPORT_PREFIXES = Object.freeze(["cloudflare:", "node:"]);
const NODE_BUILTIN_MODULE_SPECIFIERS = new Set(
  builtinModules.flatMap((specifier) => [specifier, specifier.replace(/^node:/u, "")]),
);

const isAbsoluteModuleSpecifier = (specifier) =>
  specifier.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(specifier);

const isBarePackageSpecifier = (specifier) =>
  !ALLOWED_IMPORT_PREFIXES.some((prefix) => specifier.startsWith(prefix)) &&
  !NODE_BUILTIN_MODULE_SPECIFIERS.has(specifier) &&
  !specifier.startsWith(".") &&
  !isAbsoluteModuleSpecifier(specifier);

const literalModuleSpecifier = (node) =>
  node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;

const moduleSpecifier = (node) => {
  if (
    node.type === "ImportDeclaration" ||
    node.type === "ExportNamedDeclaration" ||
    node.type === "ExportAllDeclaration"
  )
    return literalModuleSpecifier(node.source);
  if (node.type === "ImportExpression") return literalModuleSpecifier(node.source);
  if (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require"
  )
    return literalModuleSpecifier(node.arguments[0]);
  return undefined;
};

const childNodes = (node) => {
  const children = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child !== null && typeof child === "object" && typeof child.type === "string")
          children.push(child);
      }
    } else if (value !== null && typeof value === "object" && typeof value.type === "string") {
      children.push(value);
    }
  }
  return children;
};

export const collectBarePackageImports = (source) => {
  const root = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const imports = new Map();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    const specifier = moduleSpecifier(node);
    if (specifier !== undefined && isBarePackageSpecifier(specifier) && !imports.has(specifier))
      imports.set(specifier, node.start);
    pending.push(...childNodes(node));
  }
  return [...imports.entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([specifier]) => specifier);
};

export const barePackageImports = (sources) =>
  sources.flatMap((source) => collectBarePackageImports(source));
