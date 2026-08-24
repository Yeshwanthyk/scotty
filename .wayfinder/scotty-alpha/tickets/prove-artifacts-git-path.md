---
title: Prove the Cloudflare Artifacts Git path
status: closed
label: wayfinder:task
mode: HITL
assignee: yesh
blocked_by: []
---

## Question

Do the pinned Cloudflare and Alchemy versions provide the required Mirror, per-Session Fork, normal Git clone and push, and narrow token mint and revoke primitives without placing a GitHub credential in Session compute?

## Resolution

Keep Cloudflare Artifacts as the alpha Git host for Session work. The pinned versions provide the
required low-level primitives, but Scotty must compose them into its own repository lifecycle.

Source inspection and a live proof against the configured Cloudflare account established that:

- Alchemy `2.0.0-beta.72` can bind a Cloudflare Artifacts namespace to a Worker.
- Cloudflare can import the public `Yeshwanthyk/scotty` `main` branch into an Artifacts repository.
- Artifacts can create an isolated repository Fork from that imported repository.
- A normal Git client can clone and push through the Artifacts HTTPS remote.
- A read token can fetch but cannot push; a write token can push.
- Scotty can mint a replacement token, revoke the old token, and continue with the replacement.
- The first Git push attempted with the revoked token was rejected 114 ms after revocation
  returned.
- Git can receive the token through an authorization header without storing it in the remote URL,
  Git config, captured output, or proof files.
- Temporary repositories, the Worker, and local Alchemy state were deleted and their absence was
  verified.

Artifacts does not provide an ongoing GitHub Mirror. Its documented import is a one-time copy of a
public HTTPS repository, and it does not accept a private GitHub credential reference. Scotty must
own the public/private GitHub-to-Mirror bridge, refresh a Mirror when a repository is registered,
when explicitly requested, and before a new Session Fork, and pin the verified source commit.
Existing Session Forks do not update when the Mirror changes.

The live proof used a real Artifacts token only in the trusted local proof process. It did not
weaken Scotty's product rule that Session compute receives only a Session-bound sentinel. The exact
private Mirror transport and sentinel-to-Artifact-token boundary remain a newly explicit decision.

Artifacts also does not replace R2. The Artifacts Fork is the durable Git remote for committed
work. R2 remains the immutable recovery path for a point-in-time workspace, including uncommitted,
untracked, and non-Git runtime state. The authoritative state and Session lifecycle tickets will
settle the exact checkpoint and recovery contract.

Evidence: [`docs/research/cloudflare-artifacts-git-path.md`](../../../docs/research/cloudflare-artifacts-git-path.md)
and the throwaway live proof under `work/artifacts-git-proof/`.
