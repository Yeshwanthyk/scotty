import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const toRepoRelative = (filename) =>
  path.relative(repoRoot, path.resolve(filename)).split(path.sep).join("/");

export const isConfigOrTooling = (filename) => {
  const normalized = toRepoRelative(filename);
  return (
    /(^|\/)(vite|vitest|wrangler)\.config\.[cm]?ts$/.test(normalized) ||
    normalized.startsWith("scripts/")
  );
};

export const isTestLike = (filename) => {
  const normalized = toRepoRelative(filename);
  return (
    /(\.|\/)(test|spec|e2e|node\.test)\.[cm]?[jt]sx?$/.test(normalized) ||
    normalized.startsWith("tests/")
  );
};

export function unwrapExpression(node) {
  let current = node;
  while (
    [
      "ChainExpression",
      "ParenthesizedExpression",
      "TSNonNullExpression",
      "TSAsExpression",
      "TSTypeAssertion",
    ].includes(current?.type)
  ) {
    current = current.expression;
  }
  return current;
}

export function getPropertyName(node) {
  if (node?.type === "Identifier" || node?.type === "PrivateIdentifier") return node.name;
  if (
    (node?.type === "Literal" || node?.type === "StringLiteral") &&
    typeof node.value === "string"
  )
    return node.value;
  return undefined;
}

export const isIdentifier = (node, name) =>
  node?.type === "Identifier" && (name === undefined || node.name === name);

export const getCallName = (node) => {
  const expression = unwrapExpression(node);
  if (expression?.type === "Identifier") return expression.name;
  return expression?.type === "MemberExpression" ? getPropertyName(expression.property) : undefined;
};

export const nodeName = (node) =>
  isIdentifier(node) || node?.type === "PrivateIdentifier" ? node.name : undefined;

export const getStringValue = (node) => {
  const expression = unwrapExpression(node);
  return (expression?.type === "Literal" || expression?.type === "StringLiteral") &&
    typeof expression.value === "string"
    ? expression.value
    : undefined;
};

export const isStringLiteral = (node) => getStringValue(node) !== undefined;

export function typeName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "TSQualifiedName") {
    const left = typeName(node.left);
    const right = typeName(node.right);
    return left && right ? `${left}.${right}` : undefined;
  }
  return undefined;
}

export const typeReferenceName = (node) =>
  node?.type === "TSTypeReference" ? typeName(node.typeName) : undefined;

export const isEffectMember = (node, names) => {
  const expression = unwrapExpression(node);
  return (
    expression?.type === "MemberExpression" &&
    isIdentifier(unwrapExpression(expression.object), "Effect") &&
    names.has(getPropertyName(expression.property))
  );
};
