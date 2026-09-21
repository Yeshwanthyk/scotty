import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";
export default {
  meta: { type: "problem", docs: { description: "Disallow JSON.parse in Effect domain code." } },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (
          callee?.type === "MemberExpression" &&
          isIdentifier(unwrapExpression(callee.object), "JSON") &&
          getPropertyName(callee.property) === "parse"
        )
          context.report({
            node,
            message:
              "Decode JSON with Effect Schema at the boundary. Skill: decoding-effect-boundaries.",
          });
      },
    };
  },
};
