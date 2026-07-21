import { isIdentifier } from "../utils.js";
const isRecordUnknown = (node) =>
  node?.type === "TSTypeReference" &&
  isIdentifier(node.typeName, "Record") &&
  node.typeArguments?.params?.length === 2 &&
  node.typeArguments.params[1]?.type === "TSUnknownKeyword";
const banned = (node) => node?.type === "TSTypeLiteral" || isRecordUnknown(node);
export default {
  meta: { type: "problem", docs: { description: "Disallow inline object-shaped assertions." } },
  create(context) {
    const check = (node) => {
      if (banned(node.typeAnnotation))
        context.report({
          node,
          message:
            "Use a named type, Schema, or precise guard instead of an inline object assertion. Skill: decoding-effect-boundaries.",
        });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};
