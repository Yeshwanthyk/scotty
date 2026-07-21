import { getPropertyName, getStringValue, unwrapExpression } from "../utils.js";
const modules = new Set(["Option", "Either", "Result", "Cause", "Exit"]);
const tags = new Map([
  ["Some", ["Option"]],
  ["None", ["Option"]],
  ["Left", ["Either", "Result"]],
  ["Right", ["Either", "Result"]],
  ["Success", ["Exit", "Result"]],
  ["Failure", ["Exit", "Result"]],
  ["Fail", ["Cause"]],
  ["Die", ["Cause"]],
  ["Interrupt", ["Cause"]],
  ["Sequential", ["Cause"]],
  ["Parallel", ["Cause"]],
  ["Then", ["Cause"]],
  ["Both", ["Cause"]],
  ["Empty", ["Cause"]],
]);
const tagAccess = (node) => {
  const value = unwrapExpression(node);
  return value?.type === "MemberExpression" && getPropertyName(value.property) === "_tag"
    ? value
    : undefined;
};
export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow internal _tag checks for Effect-owned data." },
  },
  create(context) {
    const imported = new Set();
    const check = (node, accessCandidate, tagCandidate) => {
      const access = tagAccess(accessCandidate);
      const tag = getStringValue(tagCandidate);
      if (access && tags.get(tag)?.some((name) => imported.has(name)))
        context.report({
          node: access,
          message: `Use Effect public predicates instead of checking internal _tag "${tag}". Skill: modeling-effect-errors.`,
        });
    };
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (source === "effect")
          for (const specifier of node.specifiers ?? []) {
            const name = specifier.imported?.name ?? specifier.imported?.value;
            if (modules.has(name)) imported.add(name);
          }
        else if (
          typeof source === "string" &&
          source.startsWith("effect/") &&
          modules.has(source.slice(7))
        )
          imported.add(source.slice(7));
      },
      BinaryExpression(node) {
        if (!["===", "!==", "==", "!="].includes(node.operator)) return;
        check(node, node.left, node.right);
        check(node, node.right, node.left);
      },
    };
  },
};
