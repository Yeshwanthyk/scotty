import {
  addEffectNamespaceImport,
  getPropertyName,
  isIdentifier,
  unwrapExpression,
} from "../utils.js";

const message =
  "Do not use Schema.Class or Schema.TaggedClass. Use Schema.Struct / Schema.TaggedStruct and Schema.is(schema) for runtime checks. Effect 4 Schema.Class encodes with an instanceof check that plain structurally typed objects fail. Schema.TaggedErrorClass and Schema.ErrorClass remain valid typed-error forms.";
const isSchemaClassCall = (node, schemaNames) => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "CallExpression") return false;
  let callee = unwrapExpression(expression.callee);
  while (callee?.type === "CallExpression") callee = unwrapExpression(callee.callee);
  return (
    callee?.type === "MemberExpression" &&
    isIdentifier(unwrapExpression(callee.object)) &&
    schemaNames.has(unwrapExpression(callee.object).name) &&
    ["Class", "TaggedClass"].includes(getPropertyName(callee.property))
  );
};

export default {
  meta: { type: "problem", docs: { description: "Disallow Schema.Class and Schema.TaggedClass." } },
  create(context) {
    const schemaNames = new Set();
    return {
      ImportDeclaration(node) {
        addEffectNamespaceImport(node, "effect/Schema", "Schema", schemaNames);
      },
      CallExpression(node) {
        if (node.parent?.type === "CallExpression" && node.parent.callee === node) return;
        if (isSchemaClassCall(node, schemaNames)) context.report({ node, message });
      },
    };
  },
};
