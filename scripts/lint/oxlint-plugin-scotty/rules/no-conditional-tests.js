import { getPropertyName, isIdentifier, isTestLike, unwrapExpression } from "../utils.js";

const isAssertionCall = (node, assertionNames) => {
  const callee = unwrapExpression(node);
  if (isIdentifier(callee)) return assertionNames.has(callee.name);
  if (callee?.type !== "MemberExpression") return false;
  let root = unwrapExpression(callee.object);
  while (root?.type === "MemberExpression") root = unwrapExpression(root.object);
  return isIdentifier(root) && assertionNames.has(root.name);
};

export default {
  meta: { type: "problem", docs: { description: "Disallow conditional assertions in tests." } },
  create(context) {
    if (!isTestLike(context.filename)) return {};
    const assertionNames = new Set(["expect"]);
    let depth = 0;
    const enter = () => {
      depth += 1;
    };
    const exit = () => {
      depth -= 1;
    };
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "@effect/vitest" && node.source.value !== "vitest") return;
        for (const specifier of node.specifiers ?? []) {
          if (
            specifier.type === "ImportSpecifier" &&
            ["assert", "expect"].includes(getPropertyName(specifier.imported))
          ) {
            assertionNames.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        if (depth > 0 && isAssertionCall(node.callee, assertionNames))
          context.report({
            node,
            message:
              "Avoid conditional assertions; split the test or assert the branch and value explicitly. Skill: testing-effect-programs.",
          });
      },
      IfStatement: enter,
      "IfStatement:exit": exit,
      ConditionalExpression: enter,
      "ConditionalExpression:exit": exit,
      LogicalExpression: enter,
      "LogicalExpression:exit": exit,
      SwitchCase: enter,
      "SwitchCase:exit": exit,
    };
  },
};
