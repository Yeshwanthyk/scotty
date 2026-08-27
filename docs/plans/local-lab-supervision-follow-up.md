# Local lab supervision follow-up

## Orientation

Scotty production infrastructure and deployment remain Alchemy-owned. The local lab intentionally uses `wrangler dev --local` only as a workerd and Sandbox host adapter; this plan does not replace that arrangement.

During the Q3 container Pi protocol baseline proof at clean commit `a00de625`, a real local session completed `beam up`, `inspect`, and `steer`. During the eleventh passive inspection, the recorded Wrangler leader disappeared while one workerd child and the two run-owned Sandbox containers remained alive. The CLI then refused vaporize because the lab leader was gone, and `lab stop` correctly reported `cleanup-pending` rather than signaling an ambiguously owned process. Exact manual cleanup of the recorded process group and named containers allowed `lab stop` to finish.

Handle this later as a local lab supervision issue. Do not fold it into the Pi protocol cleanup or treat local Wrangler proof as Alchemy deployment proof.

## Contracts

- Alchemy remains the only production resource and deployment authority.
- Wrangler remains a bounded local host adapter; it must not become a second deployment or reconciliation path.
- The lab never signals a PID or process group after ownership evidence diverges.
- Cleanup targets only the recorded run's process group, temporary root, and worker-named containers.
- A missing leader with live owned children or containers remains visible as `cleanup-pending`; it must not be reported as success.
- Root, GitHub, and Pi credentials remain redacted from diagnostics and cleanup evidence.

## Work

### 1. Characterize the observed leader-loss path

Use the existing process helpers in `scripts/scotty-lab.mjs` and `e2e/support/local-worker.mjs`. Add a deterministic test fixture for: recorded leader exits, an exact child remains in the recorded process group, and run-owned containers remain. Confirm the current stop refusal and identify whether Wrangler, the launch wrapper, or lab detachment owns the leader lifetime. Do not add synthetic failure branches beyond this observed state.

### 2. Make recovery explicit and ownership-safe

Choose the smallest correction supported by the characterization:

- retain enough immutable launch evidence to distinguish an owned orphaned process group from PID reuse;
- stop only when that evidence still matches;
- remove only containers selected by the exact recorded worker name;
- persist actionable, redacted cleanup evidence when automatic proof is insufficient.

Do not weaken `validateLabProcess`, infer ownership from ports or generic process names, or silently convert ambiguity to success.

### 3. Prove the same real flow

Run the focused lab tests, then the same authorized local lifecycle:

```text
start -> doctor --json -> beam up -> inspect -> steer -> settled inspect -> vaporize -> stop
```

Prove both normal cleanup and the characterized missing-leader recovery. Run formatting, lint skills, affected typechecks, Knip, `npm run test:all`, and the static scan. The result remains local-only; guarded Alchemy deployment and deployed canary stay separate.

## Starting symbols

- `scripts/scotty-lab.ts`: `startLab`, `executeLab`, `stopLab`, `cleanupResources`
- `scripts/scotty-lab.mjs`: `launchWrangler`, `validateLabProcess`, `terminateManifestProcess`, `removeWorkerContainers`
- `e2e/support/local-worker.mjs`: Wrangler launch and worker-container cleanup helpers
- `scripts/scotty-lab.test.ts` and `scripts/scotty-lab.test.mjs`: process ownership and cleanup characterization
- `docs/scotty-lab.md`: local proof limits and operator recovery

## Completion and stop criteria

Complete only when the observed leader-loss state has deterministic coverage, normal and recovery cleanup are ownership-safe, no credential appears in evidence, and the real local lifecycle leaves no process, container, manifest, or temporary root behind.

Stop if the correction requires changing production deployment authority, bypassing ownership validation, broad container deletion, or redesigning Worker/Container lifecycle. Record any such need for separate discussion instead.
