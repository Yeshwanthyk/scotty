import { addEffectNamespaceImport, getPropertyName, isIdentifier } from "../utils.js";

const unsupported = new Map([
  [
    "async",
    "Effect.async is absent from Scotty's pinned Effect 4.0.0-beta.99. Use Effect.callback for callback adapters.",
  ],
  [
    "zipRight",
    "Effect.zipRight is absent from Scotty's pinned Effect 4.0.0-beta.99. Use Effect.andThen or Effect.gen sequencing.",
  ],
  [
    "timeoutFail",
    "Effect.timeoutFail is absent from Scotty's pinned Effect 4.0.0-beta.99. Use Effect.timeoutOrElse or Effect.timeoutOption.",
  ],
]);

export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow Effect APIs absent from pinned beta.99." },
  },
  create(context) {
    const effectNames = new Set();
    return {
      ImportDeclaration(node) {
        addEffectNamespaceImport(node, "effect/Effect", "Effect", effectNames);
      },
      MemberExpression(node) {
        if (!isIdentifier(node.object) || !effectNames.has(node.object.name)) return;
        const property = getPropertyName(node.property);
        if (unsupported.has(property))
          context.report({
            node,
            message: `${unsupported.get(property)} Skill: modeling-effect-errors.`,
          });
      },
    };
  },
};
