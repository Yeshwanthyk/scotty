import { getPropertyName, isIdentifier } from "../utils.js";
const violation = (node) =>
  node?.type === "YieldExpression" &&
  node.delegate &&
  node.argument?.type === "CallExpression" &&
  node.argument.callee?.type === "MemberExpression" &&
  isIdentifier(node.argument.callee.object, "Effect") &&
  getPropertyName(node.argument.callee.property) === "fail" &&
  node.argument.arguments?.[0]?.type === "NewExpression" &&
  isIdentifier(node.argument.arguments[0].callee) &&
  node.argument.arguments[0].callee.name !== "Error" &&
  node.argument.arguments[0].callee.name.endsWith("Error");
export default {
  meta: { type: "problem", docs: { description: "Prefer directly yielding tagged errors." } },
  create(context) {
    return {
      YieldExpression(node) {
        if (violation(node))
          context.report({
            node,
            message:
              "Yield tagged errors directly inside Effect.gen. Skill: modeling-effect-errors.",
          });
      },
    };
  },
};
