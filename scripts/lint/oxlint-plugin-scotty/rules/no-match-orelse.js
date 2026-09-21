import { addEffectNamespaceImport, isIdentifier } from "../utils.js";

const message =
  "Do not use Match.orElse as a catch-all fallback. End the Match chain with Match.exhaustive, or use Match.option / Match.orElseAbsurd when partiality is intentional.";

export default {
  meta: { type: "problem", docs: { description: message } },
  create(context) {
    const matchNames = new Set();
    return {
      ImportDeclaration(node) {
        addEffectNamespaceImport(node, "effect/Match", "Match", matchNames);
      },
      CallExpression(node) {
        if (
          node.callee?.type === "MemberExpression" &&
          isIdentifier(node.callee.object) &&
          matchNames.has(node.callee.object.name) &&
          isIdentifier(node.callee.property, "orElse")
        ) {
          context.report({ node, message });
        }
      },
    };
  },
};
