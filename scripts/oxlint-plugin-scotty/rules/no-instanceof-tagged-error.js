import { isIdentifier, nodeName } from "../utils.js";
export default {
  meta: { type: "problem", docs: { description: "Disallow instanceof for tagged errors." } },
  create(context) {
    return {
      BinaryExpression(node) {
        const name = nodeName(node.right);
        if (
          node.operator === "instanceof" &&
          isIdentifier(node.right) &&
          name !== "Error" &&
          name?.endsWith("Error")
        )
          context.report({
            node,
            message:
              "Use Effect.catchTag, Effect.catchTags, or Predicate.isTagged. Skill: modeling-effect-errors.",
          });
      },
    };
  },
};
