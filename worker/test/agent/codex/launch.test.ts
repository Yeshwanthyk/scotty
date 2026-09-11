import { assert, describe, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { CodexLaunch } from "../../../src/agent/codex/process";
import {
  CodexModelCapability,
  codexModelCapabilities,
  codexModelCapability,
} from "../../../../protocol/codex-model-capabilities";
import { managedPiAccessToken } from "../../../src/credentials/managed";

const decode = Schema.decodeUnknownResult(CodexLaunch, { onExcessProperty: "error" });
const decodeCapability = Schema.decodeUnknownResult(CodexModelCapability, {
  onExcessProperty: "error",
});
const selection = {
  binary: "/usr/local/bin/codex",
  runtimeDir: "/runtime/codex-generation",
  workspace: "/workspace/session",
  model: "gpt-5.4",
  effort: "high",
  credential: {
    sentinel: managedPiAccessToken("scotty-managed://openai/openai-codex/access"),
    expiresAt: Number.MAX_SAFE_INTEGER,
  },
};

describe("explicit managed launch admission", () => {
  it("accepts the bounded pinned catalog subset without provider or auth defaults", () => {
    for (const capability of codexModelCapabilities)
      for (const effort of capability.efforts)
        assert.ok(Result.isSuccess(decode({ ...selection, model: capability.slug, effort })));
    assert.deepStrictEqual(codexModelCapability("gpt-6-astra"), {
      slug: "gpt-6-astra",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      toolMode: "code_mode_only",
    });
    assert.equal(codexModelCapability("unknown"), undefined);
  });
  it("accepts only bounded Session-owned identities while preserving standalone launch", () => {
    assert.ok(Result.isSuccess(decode({ ...selection, sessionId: "a0b1c2d3e4f5" })));
    for (const sessionId of ["", "../session", "a0b1c2d3e4f5\n", null, 1])
      assert.ok(Result.isFailure(decode({ ...selection, sessionId })));
  });
  it("bounds the optional handshake budget below the outer 30s readiness deadline", () => {
    for (const startupTimeoutMs of [10, 1000, 15000])
      assert.ok(Result.isSuccess(decode({ ...selection, startupTimeoutMs })));
    for (const startupTimeoutMs of [0, 9, 15001, 30000, Infinity, NaN, 10.5, "15000", null])
      assert.ok(Result.isFailure(decode({ ...selection, startupTimeoutMs })));
  });
  it("keeps ephemeral history as the default and bounds durable resume input", () => {
    assert.ok(Result.isSuccess(decode(selection)));
    assert.ok(Result.isSuccess(decode({ ...selection, ephemeral: true })));
    assert.ok(Result.isSuccess(decode({ ...selection, ephemeral: false })));
    assert.ok(
      Result.isSuccess(decode({ ...selection, ephemeral: false, resumeThreadId: "thread-01" })),
    );
    for (const resumeThreadId of ["", "x".repeat(257), "thread\nunsafe", null, 1])
      assert.ok(Result.isFailure(decode({ ...selection, ephemeral: false, resumeThreadId })));
    for (const launch of [
      { ...selection, resumeThreadId: "thread-01" },
      { ...selection, ephemeral: true, resumeThreadId: "thread-01" },
    ])
      assert.ok(Result.isFailure(decode(launch)));
  });
  it("rejects incomplete or incompatible capability metadata", () => {
    for (const capability of codexModelCapabilities)
      assert.ok(Result.isSuccess(decodeCapability(capability)));
    for (const metadata of [
      { slug: "gpt-6-astra", efforts: ["ultra"] },
      { slug: "gpt-6-astra", efforts: [], toolMode: "code_mode_only" },
      { slug: "gpt-6-astra", efforts: ["future"], toolMode: "code_mode_only" },
      { slug: "gpt-6-astra", efforts: ["ultra"], toolMode: "future" },
    ])
      assert.ok(Result.isFailure(decodeCapability(metadata)));
  });
  it("requires every selection and rejects provider injection, native tokens and unsupported settings", () => {
    for (const key of Object.keys(selection))
      assert.ok(
        Result.isFailure(
          decode(Object.fromEntries(Object.entries(selection).filter(([name]) => name !== key))),
        ),
      );
    for (const change of [
      { model: "arbitrary-model" },
      { model: "gpt-6-astra-unknown" },
      { model: "gpt-5.6-luna", effort: "ultra" },
      { model: "gpt-6-astra", effort: "none" },
      { model: "gpt-5.2", effort: "max" },
      { model: "x".repeat(129) },
      { model: "" },
      { model: 'gpt-5.4"\n[other]' },
      { effort: "ultra" },
      { workspace: "relative" },
      { workspace: "/workspace\u0000" },
      { upstreamPort: 1234 },
      { baseUrl: "https://example.invalid" },
      { provider: "openai" },
      { credential: { sentinel: "dummy-real-token-shape", expiresAt: 1 } },
      {
        credential: {
          sentinel: managedPiAccessToken("scotty-managed://github/github/git-https"),
          expiresAt: 1,
        },
      },
      { credential: { ...selection.credential, refresh: "not-supported" } },
      { credential: { ...selection.credential, expiresAt: Infinity } },
    ])
      assert.ok(Result.isFailure(decode({ ...selection, ...change })));
  });
});
