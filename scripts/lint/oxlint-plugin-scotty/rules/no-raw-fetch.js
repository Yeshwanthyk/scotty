import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";

const message =
  "Do not call raw fetch in migrated Effect domain code. Use effect/unstable/http HttpClient; keep native fetch only in a narrow Cloudflare, binding, streaming proxy, third-party callback, or CLI host adapter. Skill: routing-effect-http.";

const isGlobalFetchMember = (node) => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "MemberExpression") return false;
  const object = unwrapExpression(expression.object);
  return (
    getPropertyName(expression.property) === "fetch" &&
    (isIdentifier(object, "globalThis") ||
      isIdentifier(object, "window") ||
      isIdentifier(object, "self"))
  );
};

const isBareFetch = (node) => isIdentifier(unwrapExpression(node), "fetch");

export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow raw fetch in explicitly migrated Effect domain modules." },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isBareFetch(node.callee)) {
          context.report({ node: node.callee, message });
        }
      },
      MemberExpression(node) {
        if (isGlobalFetchMember(node)) context.report({ node, message });
      },
    };
  },
};
