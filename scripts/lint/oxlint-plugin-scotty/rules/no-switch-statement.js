const message =
  "Do not use JavaScript switch statements. Use Effect Match for type-safe exhaustive pattern matching.";

export default {
  meta: { type: "problem", docs: { description: message } },
  create(context) {
    return {
      SwitchStatement(node) {
        context.report({ node, message });
      },
    };
  },
};
