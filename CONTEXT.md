# Scotty

Scotty runs durable coding-agent sessions while keeping execution infrastructure replaceable and
session authority stable.

## Language

**Session**:
A durable unit of agent work with one workspace, lifecycle, and immutable execution provider.
_Avoid_: Sandbox, box, environment

**Provider**:
A named implementation that supplies compute for a session.
_Avoid_: Location, execution target, backend

**Runner**:
A Scotty-managed service on a user-controlled machine that can host sessions.
_Avoid_: Machine enrollment, host daemon

**Connection**:
A saved relationship from one Pican client to another Pican server.
_Avoid_: Peer, machine, profile

**Control plane**:
The authority for session identity, lifecycle, credentials, policy, and provider selection.
_Avoid_: Host, coordinator

**Runtime**:
The Pican, agent, workspace, and Git processes executing inside a provider's compute.
_Avoid_: Control plane, provider
