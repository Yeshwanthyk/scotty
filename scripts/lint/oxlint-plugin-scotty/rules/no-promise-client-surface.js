import { containsPromiseType, nodeName } from "../utils.js";

const message =
  "Do not expose Promise-shaped client surfaces. Wrap third-party SDK promises at the adapter boundary and expose Effect methods. Skill: wrapping-promise-clients.";

const isExported = (node) => node?.parent?.type === "ExportNamedDeclaration";

const isClientInterface = (node) => {
  const name = nodeName(node.id);
  return (
    typeof name === "string" &&
    (name.endsWith("Client") || (isExported(node) && name.endsWith("Sdk")))
  );
};

export default {
  meta: { type: "problem", docs: { description: message } },
  create(context) {
    return {
      TSInterfaceDeclaration(node) {
        if (!isClientInterface(node)) return;
        for (const member of node.body?.body ?? []) {
          if (
            (member.type === "TSMethodSignature" && containsPromiseType(member.returnType)) ||
            (member.type === "TSPropertySignature" && containsPromiseType(member.typeAnnotation))
          ) {
            context.report({ node: member, message });
          }
        }
      },
    };
  },
};
