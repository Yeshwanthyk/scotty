# Scotty

Scotty runs durable coding-agent sessions while keeping installation identity, execution
infrastructure, and user credentials explicit.

## Language

**Installation**:
A user-chosen Scotty deployment name within a Cloudflare account. It owns a namespaced Alchemy
stack and resource set. It is never inferred from a username, machine name, repository, or account.

**Session**:
A durable unit of agent work with one workspace, lifecycle, repository branch, and immutable
execution provider.

**Provider**:
A named implementation that supplies compute for a session. Cloudflare is the production session
provider. Runner-backed session creation remains gated on a native Pi RPC worklog transport.

**Runner**:
A user-named Scotty service on a user-controlled Linux machine. Runner registration, desired state,
connection state, and session assignment are owned by the control plane.

**Control plane**:
The public Worker plus the Auth, Session, and Runner Durable Objects. It owns identity, lifecycle,
credentials, policy, installation metadata, and provider selection.

**Runtime**:
The Pi agent, workspace, RPC supervisor, and Git processes executing inside provider compute.

**Projection**:
A non-secret, rebuildable view of authoritative Durable Object state stored in KV for listing.
