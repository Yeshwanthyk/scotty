import { isIdentifier, isStringLiteral } from "../utils.js";

const message =
  "Do not inspect _tag manually. Use Effect.catchTag/catchTags for error handling, Predicate.isTagged for guards, or public Effect helpers for Effect data. Skill: modeling-effect-errors.";

const isTagProperty = (node) =>
  isIdentifier(node, "_tag") || (isStringLiteral(node) && node.value === "_tag");

const isTagAccess = (node) => node?.type === "MemberExpression" && isTagProperty(node.property);

const isReportedByParentComparison = (node) => {
  const parent = node.parent;
  return (
    parent?.type === "BinaryExpression" &&
    ["===", "!==", "==", "!="].includes(parent.operator) &&
    (parent.left === node || parent.right === node)
  );
};

export default {
  meta: { type: "problem", docs: { description: message } },
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator === "in" && isTagProperty(node.left)) {
          context.report({ node, message });
          return;
        }
        if (!["===", "!==", "==", "!="].includes(node.operator)) return;
        if (isTagAccess(node.left) || isTagAccess(node.right)) {
          context.report({ node, message });
        }
      },
      MemberExpression(node) {
        if (isTagProperty(node.property) && !isReportedByParentComparison(node)) {
          context.report({ node, message });
        }
      },
    };
  },
};
