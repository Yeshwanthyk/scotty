import { getPropertyName, isIdentifier, isStringLiteral, unwrapExpression } from "../utils.js";
export default {
  meta: { type: "problem", docs: { description: "Disallow ad hoc unknown-shape probing." } },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (
          callee?.type === "MemberExpression" &&
          isIdentifier(unwrapExpression(callee.object), "Reflect") &&
          getPropertyName(callee.property) === "get"
        )
          context.report({
            node,
            message:
              "Decode unknown input with Schema, a typed adapter, or a named guard. Skill: decoding-effect-boundaries.",
          });
      },
      BinaryExpression(node) {
        if (node.operator === "in" && isStringLiteral(node.left))
          context.report({
            node,
            message:
              "Decode unknown input instead of probing fields with in. Skill: decoding-effect-boundaries.",
          });
      },
    };
  },
};
