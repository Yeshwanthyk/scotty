import { isConfigOrTooling, unwrapExpression } from "../utils.js";

const message =
  "Avoid primitive casts like value as string. Remove redundant casts, or normalize unknown data with Schema or a typed adapter before use. Skill: decoding-effect-boundaries.";
const primitiveTypes = new Set(["TSStringKeyword", "TSNumberKeyword", "TSBooleanKeyword"]);
const isPossiblyRedundantExpression = (node) => {
  const expression = unwrapExpression(node);
  return expression?.type === "Identifier" || expression?.type === "MemberExpression";
};

export default {
  meta: { type: "problem", docs: { description: message } },
  create(context) {
    if (isConfigOrTooling(context.filename)) return {};
    const check = (node) => {
      if (
        primitiveTypes.has(node.typeAnnotation?.type) &&
        isPossiblyRedundantExpression(node.expression)
      )
        context.report({ node, message });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};
