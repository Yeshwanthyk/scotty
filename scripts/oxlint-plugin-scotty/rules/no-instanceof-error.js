import { nodeName } from "../utils.js";
export default {
  meta: { type: "problem", docs: { description: "Disallow instanceof Error." } },
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator === "instanceof" && nodeName(node.right) === "Error")
          context.report({
            node,
            message:
              "Preserve typed failures instead of narrowing unknown values with instanceof Error. Skill: modeling-effect-errors.",
          });
      },
    };
  },
};
