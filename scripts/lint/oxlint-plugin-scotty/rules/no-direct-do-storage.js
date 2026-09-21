import { getPropertyName, isIdentifier, toRepoRelative, unwrapExpression } from "../utils.js";

const allowedFiles = new Set([
  "worker/src/auth/object.ts",
  "worker/src/runner/registry-object.ts",
  "worker/src/sandbox/config-object.ts",
  "worker/src/session/store.ts",
]);

const message =
  "Access Durable Object storage through the owning storage service instead of ctx.storage. Skill: maintaining-typescript-safety.";

const isContext = (node) => {
  const expression = unwrapExpression(node);
  if (isIdentifier(expression, "ctx")) return true;
  return (
    expression?.type === "MemberExpression" &&
    expression.object?.type === "ThisExpression" &&
    getPropertyName(expression.property) === "ctx"
  );
};

export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow direct Durable Object storage access outside its adapters." },
  },
  create(context) {
    if (allowedFiles.has(toRepoRelative(context.filename))) return {};
    return {
      MemberExpression(node) {
        if (getPropertyName(node.property) === "storage" && isContext(node.object))
          context.report({ node, message });
      },
    };
  },
};
