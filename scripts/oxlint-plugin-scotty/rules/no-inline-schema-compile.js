import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";
const methods = new Set([
  "is",
  "asserts",
  "decode",
  "decodeEffect",
  "decodeExit",
  "decodeResult",
  "decodeSync",
  "decodePromise",
  "decodeOption",
  "decodeUnknownEffect",
  "decodeUnknownExit",
  "decodeUnknownResult",
  "decodeUnknownSync",
  "decodeUnknownPromise",
  "decodeUnknownOption",
  "encode",
  "encodeEffect",
  "encodeExit",
  "encodeResult",
  "encodeSync",
  "encodePromise",
  "encodeOption",
  "encodeUnknownEffect",
  "encodeUnknownExit",
  "encodeUnknownResult",
  "encodeUnknownSync",
  "encodeUnknownPromise",
  "encodeUnknownOption",
]);
const compiler = (node) => {
  const value = unwrapExpression(node);
  return value?.type === "MemberExpression" &&
    isIdentifier(unwrapExpression(value.object), "Schema") &&
    methods.has(getPropertyName(value.property))
    ? getPropertyName(value.property)
    : undefined;
};
export default {
  meta: {
    type: "problem",
    docs: { description: "Hoist Schema compiler calls out of function bodies." },
  },
  create(context) {
    let depth = 0;
    const enter = () => {
      depth += 1;
    };
    const exit = () => {
      depth -= 1;
    };
    return {
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
      CallExpression(node) {
        const method = compiler(node.callee);
        if (depth > 0 && method)
          context.report({
            node,
            message: `Hoist Schema.${method}(...) to module scope so the compiled function is reused. Skill: decoding-effect-boundaries.`,
          });
      },
    };
  },
};
