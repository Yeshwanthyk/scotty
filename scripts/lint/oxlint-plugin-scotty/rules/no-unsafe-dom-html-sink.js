import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";

const assignmentSinks = new Set(["innerHTML", "outerHTML", "srcdoc"]);
const methodSinks = new Set(["insertAdjacentHTML", "setHTMLUnsafe"]);

const sinkMessage =
  "Do not send browser content to an unsafe DOM HTML sink. Build DOM nodes and assign textContent or safe attributes instead.";

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

const staticStringValue = (node) => {
  const expression = unwrapExpression(node);
  if (
    (expression?.type === "Literal" || expression?.type === "StringLiteral") &&
    typeof expression.value === "string"
  )
    return expression.value;
  if (expression?.type === "TemplateLiteral" && expression.expressions.length === 0)
    return expression.quasis[0]?.value.cooked ?? expression.quasis[0]?.value.raw;
  return undefined;
};

export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow unsafe DOM APIs that parse strings as HTML." },
  },
  create(context) {
    return {
      AssignmentExpression(node) {
        const target = unwrapExpression(node.left);
        if (
          target?.type === "MemberExpression" &&
          assignmentSinks.has(getPropertyName(target.property))
        )
          context.report({ node: target, message: sinkMessage });
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (callee?.type !== "MemberExpression") return;
        const method = getPropertyName(callee.property);
        if (methodSinks.has(method)) {
          context.report({ node: callee, message: sinkMessage });
          return;
        }
        if (
          (method === "write" || method === "writeln") &&
          isGlobalDocument(context, callee.object)
        ) {
          context.report({ node: callee, message: sinkMessage });
          return;
        }
        if (
          method === "setAttribute" &&
          staticStringValue(node.arguments[0])?.toLowerCase() === "srcdoc"
        )
          context.report({ node: callee, message: sinkMessage });
      },
    };
  },
};
