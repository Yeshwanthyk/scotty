---
title: Choose the model login boundary
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by: []
---

## Question

Should Scotty own model-provider authentication or reuse Pi authentication?

## Resolution

Reuse Pi login and authentication behavior. Alpha must support provider API keys and Codex OAuth. Scotty may safely store the resulting private state, but it must not build a second model-authentication system beside Pi.

## Refined local-storage boundary

“Store the resulting private state” means encrypted Credential-object generations and sanitized
local operation metadata. Scotty does not persist raw Pi API keys, Codex OAuth state, or imported
Pi auth in its local roots. Only the source Pi tool may retain its own login, which Scotty never
silently reads, rewrites, or deletes.
