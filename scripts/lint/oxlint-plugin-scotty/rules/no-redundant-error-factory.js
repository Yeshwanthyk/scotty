import { isIdentifier } from "../utils.js";

const message =
  "Do not add redundant helpers that only construct a tagged error. Construct the tagged error directly. Skill: modeling-effect-errors.";

const isErrorHelperName = (name) =>
  /^make[A-Z].*Error$/.test(name ?? "") || String(name ?? "").endsWith("Error");

const parameterName = (param) => {
  if (isIdentifier(param)) return param.name;
  if (param?.type === "AssignmentPattern" && isIdentifier(param.left)) return param.left.name;
  if (param?.type === "RestElement" && isIdentifier(param.argument)) return param.argument.name;
  return undefined;
};

const isForwardedValue = (node, parameterNames) => {
  if (node?.type === "Literal" || node?.type === "StringLiteral") return true;
  if (node?.type === "Identifier") return parameterNames.has(node.name);
  return (
    node?.type === "MemberExpression" &&
    isIdentifier(node.object) &&
    parameterNames.has(node.object.name)
  );
};

const isRedundantNewErrorExpression = (node, parameterNames) => {
  if (
    node?.type !== "NewExpression" ||
    !isIdentifier(node.callee) ||
    !node.callee.name.endsWith("Error")
  ) {
    return false;
  }
  if ((node.arguments ?? []).length === 0) return true;
  if (node.arguments.length > 1) return false;
  const argument = node.arguments[0];
  if (argument?.type === "Identifier") return parameterNames.has(argument.name);
  if (argument?.type !== "ObjectExpression") return true;
  return (argument.properties ?? []).every(
    (property) =>
      property.type !== "SpreadElement" && isForwardedValue(property.value, parameterNames),
  );
};

const returnsOnlyNewError = (node) => {
  const parameterNames = new Set((node?.params ?? []).map(parameterName).filter(Boolean));
  const body = node?.body ?? node;
  if (isRedundantNewErrorExpression(body, parameterNames)) return true;
  const statements = body?.type === "BlockStatement" ? (body.body ?? []) : [];
  return (
    statements.length === 1 &&
    statements[0]?.type === "ReturnStatement" &&
    isRedundantNewErrorExpression(statements[0].argument, parameterNames)
  );
};

const report = (context, name, fn, node) => {
  if (isErrorHelperName(name) && returnsOnlyNewError(fn)) context.report({ node, message });
};

export default {
  meta: { type: "problem", docs: { description: message } },
  create(context) {
    return {
      FunctionDeclaration(node) {
        report(context, node.id?.name, node, node);
      },
      VariableDeclarator(node) {
        if (
          isIdentifier(node.id) &&
          (node.init?.type === "ArrowFunctionExpression" ||
            node.init?.type === "FunctionExpression")
        ) {
          report(context, node.id.name, node.init, node);
        }
      },
    };
  },
};
