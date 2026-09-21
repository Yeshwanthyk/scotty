const unwrapType = (node) => {
  let current = node;
  while (current?.type === "TSParenthesizedType") current = current.typeAnnotation;
  return current;
};

const typeName = (node) => (node?.type === "Identifier" ? node.name : undefined);

const isSchemaMember = (node, name) =>
  node?.type === "MemberExpression" &&
  node.computed === false &&
  typeName(node.object) === "Schema" &&
  typeName(node.property) === name;

const isRecordStringUnknown = (node) => {
  const type = unwrapType(node);
  const params = type?.typeArguments?.params;
  return (
    type?.type === "TSTypeReference" &&
    typeName(type.typeName) === "Record" &&
    params?.length === 2 &&
    unwrapType(params[0])?.type === "TSStringKeyword" &&
    unwrapType(params[1])?.type === "TSUnknownKeyword"
  );
};

const isStringUnknownIndexSignature = (node) => {
  const type = unwrapType(node);
  const [member] = type?.members ?? [];
  const [parameter] = member?.parameters ?? [];
  return (
    type?.type === "TSTypeLiteral" &&
    type.members.length === 1 &&
    member?.type === "TSIndexSignature" &&
    parameter?.typeAnnotation?.typeAnnotation?.type === "TSStringKeyword" &&
    member.typeAnnotation?.typeAnnotation?.type === "TSUnknownKeyword"
  );
};

const isStringUnknownMappedType = (node) => {
  const type = unwrapType(node);
  return (
    type?.type === "TSMappedType" &&
    type.constraint?.type === "TSStringKeyword" &&
    type.nameType === null &&
    type.typeAnnotation?.type === "TSUnknownKeyword"
  );
};

const isSchemaRecordStringUnknown = (node) =>
  node?.type === "CallExpression" &&
  isSchemaMember(node.callee, "Record") &&
  node.arguments.length === 2 &&
  isSchemaMember(node.arguments[0], "String") &&
  isSchemaMember(node.arguments[1], "Unknown");

const isReadonly = (node) => {
  const type = unwrapType(node);
  const params = type?.typeArguments?.params;
  return (
    type?.type === "TSTypeReference" &&
    typeName(type.typeName) === "Readonly" &&
    params?.length === 1
  );
};

const isOpenUnknownDictionary = (node) => {
  const type = unwrapType(node);
  return (
    isRecordStringUnknown(type) ||
    isStringUnknownIndexSignature(type) ||
    isStringUnknownMappedType(type) ||
    (isReadonly(type) && isOpenUnknownDictionary(type.typeArguments.params[0]))
  );
};

const isDirectReadonlyChild = (node) => {
  let parent = node?.parent;
  while (parent?.type === "TSParenthesizedType" || parent?.type === "TSTypeParameterInstantiation")
    parent = parent.parent;
  const params = parent?.typeArguments?.params;
  return isReadonly(parent) && unwrapType(params?.[0]) === unwrapType(node);
};

const message =
  "Do not use Record<string, unknown>. Trace the value's full impact, then convert it to the owning strongly typed domain type. If it came from I/O, parse it at the earliest Scotty-owned boundary, as close as possible to where the data originated. If it is internal, construct a precise domain type. If the object is truly dynamic, use a named schema-derived JSON object with a precise value schema. Skill: decoding-effect-boundaries.";

export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow untyped string-keyed object dictionaries." },
  },
  create(context) {
    const check = (node) => {
      if (
        isSchemaRecordStringUnknown(node) ||
        (isOpenUnknownDictionary(node) && !isDirectReadonlyChild(node))
      ) {
        context.report({ node, message });
      }
    };

    return {
      TSTypeReference: check,
      TSTypeLiteral: check,
      TSMappedType: check,
      CallExpression: check,
    };
  },
};
