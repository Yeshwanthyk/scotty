# Commands and terminal follow-up

A new Codex session completes a command and accepts another after completion.

## Behaviors

C1 explicitly select Codex with its cloud model profile; C2 request a large command and verify its
bounded projection; C3 canonical read; C4 terminal follow-up.

## User entry points

CLI `beam`, `inspect`, `read`, `steer`; browser composer is a separate proof.

## Drive

Run the smoke helper in SKILL.md. It requests 70,000 bytes from one command, requires the matching
completed invocation, 1,200 projected `x` bytes and terminal marker, then admits a follow-up and
requires the matching completed turn, `printf` output and marker.
Before cleanup in a manual run, inspect the browser's configured model/effort against settings.
Use `read ID --last 4 --json` separately to verify readable projection; store only safe assertions.
For browser proof, enter and submit the follow-up in the composer, then correlate the new turn in CLI inspect.

## Proof

`proof.json` preserves initiated recipe, returned session, turn receipts, command/output assertions,
health and owned cleanup. The helper checks output content without storing it. Canonical projection
is capped at 1,200 bytes, so this cannot prove all 70,000 native bytes were delivered. The protocol
decoder test covers a synthetic aggregate separately; native end-to-end byte delivery is unproven.
Settings need explicit readback, not absence of CLI overrides.

## Gotchas

A 70 KB aggregate and a native JSON record over 256 KB are different boundaries. A completed model
answer without a completed command fails C2. Sleeping/deleted sessions cannot supply the same live read.
