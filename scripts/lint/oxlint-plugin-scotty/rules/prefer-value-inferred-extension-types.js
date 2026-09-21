import { isIdentifier } from "../utils.js";

const message =
  "Do not duplicate extension object shapes. Derive the extension type from the extension factory return value. Skill: inferring-value-types.";
const extensionNamePattern = /(?:Plugin)?Extension$/;
const isExtensionTypeName = (name) => typeof name === "string" && extensionNamePattern.test(name);
const isExtensionProperty = (node) =>
  node?.type === "Property" &&
  !node.computed &&
  ((node.key?.type === "Identifier" && node.key.name === "extension") ||
    ((node.key?.type === "Literal" || node.key?.type === "StringLiteral") &&
      node.key.value === "extension"));
const isSatisfiesExtension = (node, names) =>
  node?.type === "TSSatisfiesExpression" &&
  node.typeAnnotation?.type === "TSTypeReference" &&
  isIdentifier(node.typeAnnotation.typeName) &&
  names.has(node.typeAnnotation.typeName.name);
const returnsSatisfiesExtension = (node, names) => {
  if (!node) return false;
  if (isSatisfiesExtension(node, names)) return true;
  return (
    node.type === "BlockStatement" &&
    (node.body ?? []).some(
      (statement) =>
        statement.type === "ReturnStatement" && isSatisfiesExtension(statement.argument, names),
    )
  );
};
const isAnnotatedExtensionFunction = (node, names) =>
  (node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression") &&
  node.returnType?.typeAnnotation?.type === "TSTypeReference" &&
  isIdentifier(node.returnType.typeAnnotation.typeName) &&
  names.has(node.returnType.typeAnnotation.typeName.name);

export default {
  meta: { type: "problem", docs: { description: message } },
  create(context) {
    const names = new Set();
    const properties = [];
    return {
      TSInterfaceDeclaration(node) {
        if (isExtensionTypeName(node.id?.name)) names.add(node.id.name);
      },
      TSTypeAliasDeclaration(node) {
        if (isExtensionTypeName(node.id?.name) && node.typeAnnotation?.type === "TSTypeLiteral")
          names.add(node.id.name);
      },
      Property(node) {
        if (isExtensionProperty(node)) properties.push(node);
      },
      "Program:exit"() {
        for (const node of properties) {
          const value = node.value;
          if (
            isAnnotatedExtensionFunction(value, names) ||
            returnsSatisfiesExtension(value?.body, names)
          )
            context.report({ node, message });
        }
      },
    };
  },
};
