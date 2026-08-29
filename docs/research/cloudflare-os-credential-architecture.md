# Cloudflare OS credential architecture

Date: 2026-08-28
Primary source: [`cloudflare/cloudflare-os`](https://github.com/cloudflare/cloudflare-os) at commit [`14fea8592a6dbc59769d592c0752bbf6a465fa84`](https://github.com/cloudflare/cloudflare-os/tree/14fea8592a6dbc59769d592c0752bbf6a465fa84)

## Conclusion

Cloudflare OS does **not** implement a generic secret registry that copies credentials into agent sandboxes. It keeps each external account's credential in that provider's Gatekeeper Durable Object and gives agents resource-scoped RPC capabilities. The Gatekeeper—not the agent—uses the credential to call the provider.

The closest safe Scotty analogue is therefore:

```text
local credential source
  -> credential/account authority
  -> global account identity
  -> exact-repository session grant
  -> sentinel/capability in the Sandbox
  -> Scotty egress performs the authorized provider request
```

Scotty cannot copy Cloudflare OS literally because Pi, Git, and arbitrary CLI tools expect native HTTP credentials rather than typed Gatekeeper RPC APIs. Scotty's sentinel egress is the compatibility layer: it should act as the Gatekeeper and keep real values outside the Sandbox.

## What Cloudflare OS actually does

### 1. The provider account object owns credentials

The shared MCP account explicitly describes itself as the Durable Object that owns one endpoint connection and every credential for it. OAuth tokens, client registration, discovery state, and the endpoint are stored in that account object. A monotonically increasing `connectionGeneration` prevents stale connect, refresh, and transport work from publishing after reconnect or repoint.

Sources:

- [`packages/mcp-shared/src/account.ts#L1-L9`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/mcp-shared/src/account.ts#L1-L9)
- [`packages/mcp-shared/src/account.ts#L188-L210`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/mcp-shared/src/account.ts#L188-L210)
- [`packages/mcp-shared/src/account.ts#L436-L469`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/mcp-shared/src/account.ts#L436-L469)

The Google Gatekeeper follows the same ownership rule. Its `UserAccount` DO stores the refresh token and cached access token. Credential replacement, minting, and revocation are serialized through a promise-chain mutex.

Sources:

- [`packages/gatekeeper-google/src/google.ts#L402-L428`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/gatekeeper-google/src/google.ts#L402-L428)
- [`packages/gatekeeper-google/src/google.ts#L500-L518`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/gatekeeper-google/src/google.ts#L500-L518)
- [`packages/gatekeeper-google/src/google.ts#L557-L642`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/gatekeeper-google/src/google.ts#L557-L642)

The GitHub Gatekeeper likewise stores one OAuth access token in its `UserAccount` DO and retrieves it only inside the Gatekeeper's provider-call path.

Sources:

- [`packages/gatekeeper-github/src/github.ts#L1045-L1052`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/gatekeeper-github/src/github.ts#L1045-L1052)
- [`packages/gatekeeper-github/src/github.ts#L1104-L1148`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/gatekeeper-github/src/github.ts#L1104-L1148)

### 2. Agents receive capabilities, not credentials

Cloudflare OS defines Gatekeepers as separate Workers that wrap provider APIs, enforce narrow resource access, audit operations, and mediate side effects. The provider credential remains behind the Gatekeeper.

Sources:

- [`README.md#L62-L85`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/README.md#L62-L85)
- [`packages/workshop-shared/src/gatekeeper.ts#L1-L17`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/workshop-shared/src/gatekeeper.ts#L1-L17)

The Workshop builds the agent's execution environment from RPC bindings. A binding resolves to a gadget stub, Gatekeeper session stub, or bounded callback value; no provider token is inserted into the agent environment.

Source:

- [`packages/workshop-backend/src/overseer.ts#L2744-L2783`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/workshop-backend/src/overseer.ts#L2744-L2783)

### 3. Account credentials and resource grants are separate

A connected account represents the user's provider identity and OAuth grant. A resource binding narrows that account to a specific resource URL. For GitHub, grantable resources include an exact repository, issue, or pull request. Issues and pull requests inherit the repository's ACL boundary.

Sources:

- [`packages/workshop-shared/src/gatekeeper.ts#L126-L171`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/workshop-shared/src/gatekeeper.ts#L126-L171)
- [`packages/gatekeeper-github/src/github.ts#L279-L302`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/gatekeeper-github/src/github.ts#L279-L302)
- [`packages/gatekeeper-github/src/github.ts#L1338-L1346`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/gatekeeper-github/src/github.ts#L1338-L1346)

This is the important model for Scotty: **global credential identity, separately scoped grants**. Duplicating the same secret into independent global and repository stores is unnecessary.

### 4. Refresh and reconnect are fenced

The MCP account captures the current endpoint and connection generation before reading or refreshing credentials, then rechecks both after awaits. Concurrent refreshes for one generation share a single promise. A reconnect advances the generation, making old completions unable to update or return current credentials.

Sources:

- [`packages/mcp-shared/src/account.ts#L653-L689`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/mcp-shared/src/account.ts#L653-L689)
- [`packages/mcp-shared/src/account.ts#L703-L806`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/mcp-shared/src/account.ts#L703-L806)

Google serializes token minting, replacement, and revoke, rechecks credential state after acquiring the mutex, and suppresses repeated permanent failures for a bounded cooldown.

Source:

- [`packages/gatekeeper-google/src/google.ts#L557-L642`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/gatekeeper-google/src/google.ts#L557-L642)

### 5. Revocation deletes the credential owner

The MCP account attempts provider-side token revocation and then deletes all account-object state. Google uses the same serialized provider-revoke-then-delete pattern.

Sources:

- [`packages/mcp-shared/src/account.ts#L875-L891`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/mcp-shared/src/account.ts#L875-L891)
- [`packages/gatekeeper-google/src/google.ts#L663-L673`](https://github.com/cloudflare/cloudflare-os/blob/14fea8592a6dbc59769d592c0752bbf6a465fa84/packages/gatekeeper-google/src/google.ts#L663-L673)

### 6. It is not an encrypted-generation secret manager

In the inspected source, provider tokens are written directly to Durable Object storage (`tokens`, `refreshToken`, `accessToken`). The repository does not add an application-level encrypted immutable-generation registry for these account credentials. Cloudflare OS therefore does not answer Scotty's proposed wrapping-key or generic ciphertext-store design.

Do not infer from this that Durable Object storage is unencrypted by the platform; the narrower source-grounded statement is that Cloudflare OS adds no visible application-level encryption layer around these values.

## Comparison with Scotty

| Concern          | Cloudflare OS                                   | Scotty today                                               | Recommended Scotty target                                                                 |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Credential owner | Provider-specific account DO                    | Worker secrets, SandboxConfig Pi record, and Session vault | One named installation credential authority                                               |
| Scope            | Account plus resource-specific Gatekeeper       | Installation Pi seed; installation-wide GitHub secret      | Global credential plus exact-repository grants                                            |
| Agent exposure   | Typed RPC capability only                       | Session sentinel in native auth/env                        | Keep sentinel; treat egress as compatibility Gatekeeper                                   |
| Provider calls   | Gatekeeper calls provider                       | Sandbox sends request; egress substitutes credential       | Keep egress substitution for supported HTTP adapters                                      |
| Refresh          | Account owner, serialized and generation-fenced | Session vault lease, then installation write-back          | One authority-owned generation transition with session fence                              |
| Revoke           | Provider revoke plus account-state deletion     | Pi/GitHub lifecycle is fragmented                          | Named credential revoke invalidates future and active grants according to explicit policy |
| Generic secrets  | Not provided                                    | Not provided                                               | Add only explicit HTTP credential adapters initially                                      |

## What Scotty should adopt

1. **Separate credential identity from grants.** Store one named credential globally; attach it automatically or by exact repository policy without duplicating the secret.
2. **Never give the Sandbox the source credential.** Continue using session-bound sentinels.
3. **Make egress the Gatekeeper.** Each adapter owns allowed origins, supported header/query placement, refresh behavior, and response sanitization.
4. **Use monotonic generations.** Bind every session grant, refresh lease, and asynchronous completion to a credential generation.
5. **Fence by destination and repository.** Validate the exact canonical repository before Sandbox allocation and the exact upstream origin again at egress.
6. **Serialize replacement, refresh, and revoke.** Recheck the generation after every awaited provider operation.
7. **Expose only redacted metadata.** Names, kinds, scope, generation, digest, state, and timestamps are sufficient.

## What Scotty should not copy

1. **Do not build a Gatekeeper Worker per provider.** Scotty's initial Pi/Git/GitHub use cases can share its existing Worker egress boundary.
2. **Do not require typed RPC APIs from unchanged CLI tools.** Pi and Git need their native credential shapes; sentinel compatibility is the smaller mechanism.
3. **Do not claim Cloudflare OS proves encrypted credential storage.** It does not implement the proposed generic ciphertext-generation authority.
4. **Do not materialize arbitrary plaintext environment secrets merely for parity.** Cloudflare OS's central safety property is that agents receive capabilities rather than provider credentials.

## Resulting smallest Scotty slice

```text
TOML declares named credential source + global/exact-repository grant policy
  -> scotty sync reads only the named local sources
  -> one credential authority stores the current generation
  -> session creation resolves global + exact-repository grants before allocation
  -> Session DO persists generation references and fresh sentinels
  -> container receives sentinels
  -> existing egress validates sentinel + repository grant + exact origin
  -> egress injects the real credential transiently
```

Start with Pi/OpenAI and GitHub because Scotty already has their sentinel and egress adapters. Add a generic HTTP bearer/API-key adapter only after its exact-origin and header-placement contract is explicit. Plaintext file/environment materialization should remain out.
