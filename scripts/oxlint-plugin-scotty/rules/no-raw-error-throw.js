import { isIdentifier } from "../utils.js";

const message =
  "Do not throw raw Error objects in Effect code. Return Effect.fail with a tagged error or assert directly in tests. Skill: modeling-effect-errors.";

export default {
  meta: { type: "problem", docs: { description: message } },
  create(context) {
    let importsEffect = false;
    return {
      ImportDeclaration(node) {
        if (
          node.source?.type === "Literal" &&
          (node.source.value === "effect" || node.source.value.startsWith("effect/"))
        ) {
          importsEffect = true;
        }
      },
      ThrowStatement(node) {
        if (
          importsEffect &&
          node.argument?.type === "NewExpression" &&
          isIdentifier(node.argument.callee, "Error")
        ) {
          context.report({ node, message });
        }
      },
    };
  },
};
