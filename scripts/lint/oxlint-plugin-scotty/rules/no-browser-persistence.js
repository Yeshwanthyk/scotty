import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";

const capabilities = new Set([
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "cookieStore",
]);

const message =
  "Do not persist state in the browser adapter. Keep authoritative state behind Scotty's Worker APIs.";

const isGlobalIdentifier = (context, node, name) => {
  if (!isIdentifier(node, name)) return false;
  if (context.sourceCode.isGlobalReference(node)) return true;
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const reference = scope.references.find((candidate) => candidate.identifier === node);
    if (reference) return reference.resolved === null || reference.resolved.defs.length === 0;
    scope = scope.upper;
  }
  return false;
};

const isGlobalNamespace = (context, node) =>
  ["window", "globalThis", "self"].some((name) => isGlobalIdentifier(context, node, name));

const isGlobalDocument = (context, node) => {
  const expression = unwrapExpression(node);
  if (isGlobalIdentifier(context, expression, "document")) return true;
  return (
    expression?.type === "MemberExpression" &&
    getPropertyName(expression.property) === "document" &&
    isGlobalNamespace(context, unwrapExpression(expression.object))
  );
};

export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow browser-local persistence capabilities." },
  },
  create(context) {
    return {
      Identifier(node) {
        if (capabilities.has(node.name) && isGlobalIdentifier(context, node, node.name))
          context.report({ node, message });
      },
      MemberExpression(node) {
        const property = getPropertyName(node.property);
        const object = unwrapExpression(node.object);
        if (capabilities.has(property) && isGlobalNamespace(context, object)) {
          context.report({ node, message });
          return;
        }
        if (property === "cookie" && isGlobalDocument(context, object))
          context.report({ node, message });
      },
    };
  },
};
