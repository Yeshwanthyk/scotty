import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";
const isPromiseReject = (node) => {
  const value = unwrapExpression(node);
  return (
    value?.type === "MemberExpression" &&
    isIdentifier(unwrapExpression(value.object), "Promise") &&
    getPropertyName(value.property) === "reject"
  );
};
const isFunction = (node) =>
  ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node?.type);
export default {
  meta: { type: "problem", docs: { description: "Disallow Promise rejection APIs." } },
  create(context) {
    const executors = new WeakSet();
    const rejectNames = [];
    const enter = (node) => {
      if (executors.has(node))
        rejectNames.push(isIdentifier(node.params?.[1]) ? node.params[1].name : undefined);
    };
    const exit = (node) => {
      if (executors.has(node)) rejectNames.pop();
    };
    return {
      NewExpression(node) {
        if (
          isIdentifier(unwrapExpression(node.callee), "Promise") &&
          isFunction(node.arguments?.[0])
        )
          executors.add(node.arguments[0]);
      },
      CallExpression(node) {
        if (
          isPromiseReject(node.callee) ||
          (isIdentifier(node.callee) && rejectNames.includes(node.callee.name))
        )
          context.report({
            node,
            message:
              "Model asynchronous failure with Effect.fail or Effect.tryPromise. Skill: wrapping-promise-clients.",
          });
      },
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
    };
  },
};
