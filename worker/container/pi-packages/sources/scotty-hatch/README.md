# scotty-hatch

First-party Pi extension for one bounded application Hatch inside a warm Scotty session.

It registers only `scotty_hatch`, with explicit `ensure`, `status`, and `close` operations. The
extension owns only its scoped child process group. Authoritative Hatch state and exposure remain
in the source Sandbox Durable Object behind Scotty's credential-free internal container route.
