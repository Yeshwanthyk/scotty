import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";

const message =
  "Use Predicate.isNotNull, Predicate.isNotUndefined, or Predicate.isNotNullish from effect instead of hand-rolled nullish predicates.";
const nullishOperators = new Set(["!==", "!=", "===", "=="]);
const isNullish = (node) =>
  (node?.type === "Literal" && node.value === null) || isIdentifier(node, "undefined");
const parameterName = (params) => {
  if (params.length !== 1) return undefined;
  const param = unwrapExpression(params[0]);
  return param?.type === "Identifier" ? param.name : undefined;
};
const isNullishPredicate = (node) => {
  const name = parameterName(node.params ?? []);
  const functionBody = unwrapExpression(node.body);
  const body =
    functionBody?.type === "BlockStatement" &&
    functionBody.body?.length === 1 &&
    functionBody.body[0]?.type === "ReturnStatement"
      ? unwrapExpression(functionBody.body[0].argument)
      : functionBody;
  if (
    name === undefined ||
    body?.type !== "BinaryExpression" ||
    !nullishOperators.has(body.operator)
  )
    return false;
  const left = unwrapExpression(body.left);
  const right = unwrapExpression(body.right);
  return (
    (isIdentifier(left, name) && isNullish(right)) || (isIdentifier(right, name) && isNullish(left))
  );
};
const isFilterCall = (node) => {
  const callee = unwrapExpression(node.callee);
  return callee?.type === "MemberExpression" && getPropertyName(callee.property) === "filter";
};

export default {
  meta: { type: "problem", docs: { description: message } },
  create(context) {
    let hasEffectImport = false;
    return {
      ImportDeclaration(node) {
        if (node.source?.type === "Literal" && node.source.value === "effect")
          hasEffectImport = true;
      },
      VariableDeclarator(node) {
        const init = unwrapExpression(node.init);
        if (hasEffectImport && init?.type === "ArrowFunctionExpression" && isNullishPredicate(init))
          context.report({ node: init, message });
      },
      FunctionDeclaration(node) {
        if (hasEffectImport && isNullishPredicate(node)) context.report({ node, message });
      },
      CallExpression(node) {
        if (!hasEffectImport || !isFilterCall(node)) return;
        const predicate = unwrapExpression(node.arguments[0]);
        if (
          (predicate?.type === "ArrowFunctionExpression" ||
            predicate?.type === "FunctionExpression") &&
          isNullishPredicate(predicate)
        )
          context.report({ node: predicate, message });
      },
    };
  },
};
