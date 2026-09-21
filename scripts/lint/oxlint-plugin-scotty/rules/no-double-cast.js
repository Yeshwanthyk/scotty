const hasReason = (context, node) => {
  let current = node;
  while (current) {
    if (
      context.sourceCode
        .getCommentsBefore(current)
        .some((comment) =>
          /lint-allow-double-cast:\s*boundary:\s*[a-z0-9][a-z0-9-]*/u.test(comment.value),
        )
    ) {
      return true;
    }
    if (["Program", "BlockStatement"].includes(current.type)) return false;
    current = current.parent;
  }
  return false;
};

const check = (context, node) => {
  const inner = node.expression;
  if (
    (inner?.type === "TSAsExpression" || inner?.type === "TSTypeAssertion") &&
    ["TSUnknownKeyword", "TSAnyKeyword"].includes(inner.typeAnnotation?.type) &&
    !hasReason(context, node)
  ) {
    context.report({
      node,
      message:
        "Avoid double casts through unknown/any; decode the boundary or use an adjacent 'lint-allow-double-cast: boundary: <reason>' comment. Skill: decoding-effect-boundaries.",
    });
  }
};

export default {
  meta: { type: "problem", docs: { description: "Disallow double casts through unknown or any." } },
  create(context) {
    return {
      TSAsExpression(node) {
        check(context, node);
      },
      TSTypeAssertion(node) {
        check(context, node);
      },
    };
  },
};
