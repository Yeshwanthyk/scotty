import {
  getCallName,
  getPropertyName,
  isIdentifier,
  nodeName,
  unwrapExpression,
} from "../utils.js";
const names = new Set(["cause", "e", "err", "error", "reason", "unknownError"]);
const errorLike = (node) => names.has(nodeName(unwrapExpression(node)));
const catchTagParameter = (node) => {
  const name = nodeName(unwrapExpression(node));
  let current = node?.parent;
  while (current) {
    if (["ArrowFunctionExpression", "FunctionExpression"].includes(current.type)) {
      const parent = current.parent;
      const call = parent?.type === "Property" ? parent.parent?.parent : parent;
      return (
        nodeName(unwrapExpression(current.params?.[0])) === name &&
        call?.type === "CallExpression" &&
        ["catchTag", "catchTags"].includes(getCallName(call.callee))
      );
    }
    current = current.parent;
  }
  return false;
};
export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow stringifying or reading messages from unknown errors." },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isIdentifier(unwrapExpression(node.callee), "String") && node.arguments.some(errorLike))
          context.report({
            node,
            message:
              "Keep failures typed or normalize them at a typed boundary. Skill: modeling-effect-errors.",
          });
      },
      MemberExpression(node) {
        if (
          getPropertyName(node.property) === "message" &&
          errorLike(node.object) &&
          !catchTagParameter(node.object)
        )
          context.report({
            node,
            message: "Do not read .message from an unknown error. Skill: modeling-effect-errors.",
          });
      },
      VariableDeclarator(node) {
        if (node.id?.type !== "ObjectPattern" || !errorLike(node.init)) return;
        for (const property of node.id.properties ?? [])
          if (property.type === "Property" && getPropertyName(property.key) === "message")
            context.report({
              node: property,
              message:
                "Do not destructure .message from an unknown error. Skill: modeling-effect-errors.",
            });
      },
    };
  },
};
