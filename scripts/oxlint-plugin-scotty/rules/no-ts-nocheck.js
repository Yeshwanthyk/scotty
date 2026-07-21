const directive = new RegExp(`@ts-${"nocheck"}\\b`, "u");
export default {
  meta: { type: "problem", docs: { description: "Disallow TypeScript nocheck directives." } },
  create(context) {
    return {
      Program() {
        const comment = context.sourceCode
          .getAllComments()
          .find((candidate) => directive.test(candidate.value));
        if (comment)
          context.report({
            node: comment,
            message: `Do not use @ts-${"nocheck"}; fix or narrow the types. Skill: maintaining-typescript-safety.`,
          });
      },
    };
  },
};
