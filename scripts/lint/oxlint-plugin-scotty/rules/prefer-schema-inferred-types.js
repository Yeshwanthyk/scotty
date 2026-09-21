import { getCallName, isIdentifier } from "../utils.js";
const baseName = (name) => {
  const base = name.replace(/(Schema|Model|Struct)$/u, "");
  return base && base !== name ? base : undefined;
};
const schemaExpression = (node) =>
  node?.type === "CallExpression" &&
  ((node.callee?.type === "MemberExpression" && isIdentifier(node.callee.object, "Schema")) ||
    (getCallName(node.callee) === "pipe" && schemaExpression(node.callee.object)));
export default {
  meta: {
    type: "problem",
    docs: { description: "Prefer types inferred from nearby Effect Schemas." },
  },
  create(context) {
    const bases = new Set();
    const candidates = [];
    return {
      VariableDeclarator(node) {
        if (isIdentifier(node.id) && schemaExpression(node.init)) {
          const base = baseName(node.id.name);
          if (base) bases.add(base);
        }
      },
      TSInterfaceDeclaration(node) {
        candidates.push(node);
      },
      TSTypeAliasDeclaration(node) {
        if (node.typeAnnotation?.type === "TSTypeLiteral") candidates.push(node);
      },
      "Program:exit"() {
        for (const node of candidates)
          if (bases.has(node.id?.name))
            context.report({
              node,
              message:
                "Derive this object type from its Effect Schema to prevent drift. Skill: deriving-schema-types.",
            });
      },
    };
  },
};
