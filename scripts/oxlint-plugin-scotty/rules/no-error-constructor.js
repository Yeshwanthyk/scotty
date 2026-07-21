import { nodeName } from "../utils.js";
const names = new Set([
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);
export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow built-in Error construction in Effect domain code." },
  },
  create(context) {
    const check = (node) => {
      if (names.has(nodeName(node.callee)))
        context.report({
          node,
          message:
            "Use typed domain errors in the Effect error channel; suppress only at a true adapter boundary. Skill: modeling-effect-errors.",
        });
    };
    return { NewExpression: check, CallExpression: check };
  },
};
