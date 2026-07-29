import { toRepoRelative } from "../utils.js";

const allowedFiles = new Set([
  "worker/src/auth-registry.ts",
  "worker/src/credential-vault.ts",
  "worker/src/runner-registry.ts",
  "worker/src/session-store.ts",
]);

const message =
  'Define "scotty:*" storage keys only in the storage module that owns the persisted state.';

export default {
  meta: {
    type: "problem",
    docs: { description: "Keep persisted Scotty storage-key literals in owning store modules." },
  },
  create(context) {
    if (allowedFiles.has(toRepoRelative(context.filename))) return {};
    return {
      Literal(node) {
        if (typeof node.value === "string" && node.value.startsWith("scotty:"))
          context.report({ node, message });
      },
    };
  },
};
