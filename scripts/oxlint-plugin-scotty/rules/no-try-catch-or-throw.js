export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow try/catch and throw in Effect domain code." },
  },
  create(context) {
    return {
      TryStatement(node) {
        context.report({
          node,
          message:
            "Model failures with Effect; suppress only at a true adapter boundary. Skill: modeling-effect-errors.",
        });
      },
      ThrowStatement(node) {
        context.report({
          node,
          message:
            "Use Effect.fail or a directly yielded tagged error. Skill: modeling-effect-errors.",
        });
      },
    };
  },
};
