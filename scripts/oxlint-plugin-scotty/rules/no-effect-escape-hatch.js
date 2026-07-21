import { isEffectMember, isTestLike } from "../utils.js";
const names = new Set(["die", "dieMessage", "orDie", "orDieWith"]);
export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow Effect defect escape hatches outside tests." },
  },
  create(context) {
    if (isTestLike(context.filename)) return {};
    return {
      MemberExpression(node) {
        if (isEffectMember(node, names))
          context.report({
            node,
            message:
              "Keep failures in Effect's typed error channel; suppress only at a true host edge. Skill: modeling-effect-errors.",
          });
      },
    };
  },
};
