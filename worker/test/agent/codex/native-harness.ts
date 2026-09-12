import { CodexHostError, type Cleanup } from "../../../src/agent/codex/errors";

// Receipts have free-form string slots; diagnostic output deliberately excludes them.
export const observeCleanup = (receipt: Cleanup) => ({
  cleanup: receipt.cleanup,
  descendants: receipt.descendants,
  parent: receipt.parent,
  shutdown: receipt.shutdown,
  exitCode: receipt.exit?.code ?? null,
  signalPresent: receipt.exit?.signal != null,
  failurePresent: receipt.failure !== null,
});

export const observeCodexFailure = (error: unknown) =>
  error instanceof CodexHostError
    ? {
        tag: "CodexHostError",
        code: error.code,
        cleanup: error.cleanup === undefined ? null : observeCleanup(error.cleanup),
      }
    : { tag: "unclassified", code: null, cleanup: null };

// Native subprocess tests run the same Effect core outside repository dependency resolution.
export { Effect, Exit, Result, Scope } from "effect";
export { NodeServices } from "@effect/platform-node";
export { makeSession, startCodexSession } from "../../../src/agent/codex/session";
export { makeCodexRuntime, startCodexRuntime } from "../../../src/agent/codex/runtime";
export { readCodexSavedState } from "../../../src/agent/codex/persistence";
export { CodexSyntheticUpstream } from "../../../src/agent/codex/process";
export { launchProcess } from "../../../src/agent/codex/process";
export { managedPiAccessToken } from "../../../src/credentials/managed";
export { NodeRuntime } from "@effect/platform-node";
