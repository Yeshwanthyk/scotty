---
name: maintaining-typescript-safety
description: Maintains TypeScript safety across Effect domain and host boundaries without broad suppressions, double casts, or hidden runtime ownership. Use when fixing type escape hatches or deciding where an Effect may execute.
license: MIT
compatibility: Scotty TypeScript 7 and Effect 4.0.0-beta.99.
---

# Maintain TypeScript safety

Fix the owning boundary instead of disabling the type system.

## Workflow

1. Identify whether the mismatch comes from unknown input, an incomplete local type, a native host signature, or an unsupported dependency contract.
2. Decode unknown input, improve the local type, or construct the exact required host value.
3. Remove `@ts-nocheck`, explicit `any`, non-null assertions, and casts made unnecessary by the fix.
4. If a cast is unavoidable, keep it narrow and document the invariant at that exact expression.
5. Keep Effect execution at explicit Cloudflare, Alchemy, or CLI adapters. Domain modules return Effects; they do not call `runPromise`, `runSync`, or `runFork`.

Do not cast through `unknown` or `any` to force unrelated types together. Do not create a global runtime whose lifetime can outlive a Worker request or conceal Durable Object authority. Preserve host cancellation signals when converting an Effect to a Promise.

Native `Request`, `Response`, WebSocket, stream, Durable Object, Container, and Sandbox callback types remain explicit host contracts. Avoid wrapping them in duplicate application types unless the adapter performs real translation.

Every newly migrated Effect domain module must join the strict `scotty/*` lint override in the same change. Boundary exemptions must be file- or line-specific and explain why the host owns execution.
