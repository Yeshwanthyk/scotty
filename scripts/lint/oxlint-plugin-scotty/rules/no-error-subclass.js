import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";

const message =
  "Model failures with Data.TaggedError or Schema.TaggedError instead of subclassing Error. Skill: modeling-effect-errors.";

const isError = (node) => {
  const expression = unwrapExpression(node);
  if (isIdentifier(expression, "Error")) return true;
  return (
    expression?.type === "MemberExpression" &&
    isIdentifier(unwrapExpression(expression.object), "globalThis") &&
    getPropertyName(expression.property) === "Error"
  );
};

export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow classes that extend the built-in Error class." },
  },
  create(context) {
    const check = (node) => {
      if (isError(node.superClass)) context.report({ node: node.superClass, message });
    };
    return { ClassDeclaration: check, ClassExpression: check };
  },
};
