import { isEffectMember } from "../utils.js";
const names = new Set(["runPromise", "runPromiseExit", "runSync", "runSyncExit", "runFork"]);
export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow Effect runtime execution inside migrated domain modules." },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isEffectMember(node.callee, names))
          context.report({
            node,
            message:
              "Return or compose the Effect; execute it only at an explicit host boundary. Skill: maintaining-typescript-safety.",
          });
      },
    };
  },
};
