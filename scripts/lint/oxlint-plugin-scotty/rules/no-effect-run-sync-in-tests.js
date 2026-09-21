import { isEffectMember, isTestLike } from "../utils.js";
const names = new Set(["runSync", "runSyncExit"]);
export default {
  meta: { type: "problem", docs: { description: "Disallow synchronous Effect runners in tests." } },
  create(context) {
    if (!isTestLike(context.filename)) return {};
    return {
      CallExpression(node) {
        if (isEffectMember(node.callee, names))
          context.report({
            node,
            message:
              "Use @effect/vitest it.effect and assert; never Effect.runSync in tests. Skill: testing-effect-programs.",
          });
      },
    };
  },
};
