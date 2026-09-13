# Hatch preparation and language toolchains

Hatch uses the repository's `hatch.toml` to prepare the app, start its service, and wait for
loopback health before the Session records its registration. A command's exit code alone does not
prove the service is ready.

## Local executable proof

Run `bun test worker/container/pi-packages/sources/scotty-hatch/index.test.ts`. The real manager
fixture reads a temporary repository config, builds a TypeScript service with Bun, starts it with
Node, checks `/health` on loopback, repeats ensure without preparing again, and stops its owned
process group. Its Session authority is an in-memory transport; this is not a deployed actor test.

Run `npm run check:container-image` on a supported Linux image builder. The gate verifies pinned
Go and Rust archive digests and runs offline Node, Bun, npm, pnpm, Python, C, C++, Go and Rust
programs. Node, Bun, Go and Rust each build or launch a local HTTP service and return the expected
health body. A local emulated browser failure is separate from the language workflow result; use
the CI native-amd64 image gate for the full image outcome.

## Deployed proof

For a lab-owned session, run
`npm run lab -- lifecycle hatch-observe --session ID --turn TURN_ID --expect ready` after
the native ensure turn. It correlates one completed native Hatch receipt to the exact turn and
checks public Hatch state, reference, running process and health timestamp. Use `startup-failed`
for a failed native turn and matching public startup failure. After the existing lab sleep-resume
step, call native Hatch status in a new turn and run `hatch-observe` with that turn ID and `ready`.
The lab return must say `succeeded` and
include the expected `hatchProof`; a pending or failed action is not proof. These are local
Worker assertions, not deployed evidence. The post-resume turn must be new; a pre-resume status
snapshot cannot prove restoration.

On an explicitly selected deployed installation, create an owned session for a repository with reviewed
`hatch.toml`. Call the native `scotty_hatch` ensure tool through a model turn. Match its canonical
tool receipt to that turn and read the public Hatch status for the same service, port, and running
state. Request the health route through the supported public URL, then sleep and resume the exact
session. Call Hatch status again and require a fresh native receipt plus a healthy restored
service. Capture startup failures and restore failures as separate states. Vaporize only that
owned session and retain the evidence. This deployed path is unproven until a passing run records
each assertion; neither the local fixture nor the image gate establishes public exposure.
