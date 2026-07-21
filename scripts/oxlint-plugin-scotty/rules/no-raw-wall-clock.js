import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";
const timers = new Set(["setTimeout", "setInterval"]);
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow raw wall-clock and timer APIs in migrated Effect domain modules.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        const dateNow =
          callee?.type === "MemberExpression" &&
          isIdentifier(unwrapExpression(callee.object), "Date") &&
          getPropertyName(callee.property) === "now";
        if (dateNow || (isIdentifier(callee) && timers.has(callee.name)))
          context.report({
            node,
            message:
              "Use Effect Clock and TestClock instead of raw wall-clock or timer APIs. Skill: testing-effect-programs.",
          });
      },
      NewExpression(node) {
        if (isIdentifier(unwrapExpression(node.callee), "Date") && node.arguments.length === 0)
          context.report({
            node,
            message:
              "Use Effect Clock and TestClock instead of a zero-argument Date constructor. Skill: testing-effect-programs.",
          });
      },
    };
  },
};
