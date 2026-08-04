const message =
  'Do not use the legacy browser console "/rpc" path. Use the versioned public console routes.';

const containsRpcPathSegment = (value) => /\/rpc(?:[/?#]|$)/.test(value);

const isPropertyKey = (node) => {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "MemberExpression" && parent.property === node) return true;
  return (
    ["Property", "PropertyDefinition", "MethodDefinition", "AccessorProperty"].includes(
      parent.type,
    ) && parent.key === node
  );
};

const isTemplatePropertyKey = (node) => {
  const template = node.parent;
  return template?.type === "TemplateLiteral" && isPropertyKey(template);
};

export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow static legacy browser console /rpc paths." },
  },
  create(context) {
    return {
      Literal(node) {
        if (
          typeof node.value === "string" &&
          containsRpcPathSegment(node.value) &&
          !isPropertyKey(node)
        )
          context.report({ node, message });
      },
      TemplateElement(node) {
        const value = node.value.cooked ?? node.value.raw;
        if (containsRpcPathSegment(value) && !isTemplatePropertyKey(node))
          context.report({ node, message });
      },
    };
  },
};
