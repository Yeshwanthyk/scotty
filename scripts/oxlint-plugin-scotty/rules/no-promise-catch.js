import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";
export default {
  meta: { type: "problem", docs: { description: "Disallow Promise-style .catch()." } },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (
          callee?.type === "MemberExpression" &&
          getPropertyName(callee.property) === "catch" &&
          !isIdentifier(unwrapExpression(callee.object), "Effect")
        )
          context.report({
            node,
            message:
              "Wrap Promise failures once with Effect.tryPromise and typed errors. Skill: wrapping-promise-clients.",
          });
      },
    };
  },
};
