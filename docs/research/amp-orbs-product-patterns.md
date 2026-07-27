# Amp Orbs product patterns for Scotty

Research snapshot: 2026-07-25. This note uses Amp's first-party
[Orbs manual](https://ampcode.com/manual/orbs) and the directly linked
[Owner's Manual](https://ampcode.com/manual). It focuses on interaction
patterns, not Amp's infrastructure implementation.

## Conclusion

The useful idea is to make each task a durable, independently addressable
conversation, then choose where that task executes. Amp calls the durable task
object a thread and can place it in a fresh hosted orb or on a named runner.
The thread remains the thing a user opens, steers, reads, searches, references,
and archives; the execution location is a property of that task, not the
primary navigation object
([Orbs: Getting Started](https://ampcode.com/manual/orbs#getting-started),
[Runners](https://ampcode.com/manual#runners)).

Scotty should borrow that separation:

1. Create one session per user task, with its own prompt, status, changes, and
   execution binding.
2. Let creation choose a location such as a cloud workspace or a named personal
   runner without changing the session interaction model.
3. Keep the session ID and session history stable while runtime IDs, machines,
   attachments, and resumptions change underneath.
4. Offer three steering intents: queue after the current turn, deliver at the
   next safe step boundary, or interrupt and deliver now.
5. Make completed and running sessions easy to scan, filter, reopen, reference,
   and archive.

Do not copy the Amp-specific mechanics: a fresh repository clone for every
thread, Amp projects, `amp -ox`, Amp's plugin API, tmux, orb pricing, portal URL
format, or runner command-line flags. Those are implementations of the pattern,
not the product contract Scotty needs.

## Task distribution across execution locations

Amp exposes the same task-creation concept from the web, CLI, TUI, and plugins.
Creating an orb thread provisions a fresh orb, clones the chosen project's
repository, and starts the agent. A plugin can instead create a thread with
`executor: 'orb'` or target a live runner with
`executor: { type: 'runner', id }`
([Orbs: Getting Started](https://ampcode.com/manual/orbs#getting-started),
[plugin executor selection](https://ampcode.com/manual#define-a-custom-subagent)).

Runners are ordinary Amp instances that accept remote thread creation in the
directory where they started. A headless runner can have a stable, human-chosen
runner ID; an existing thread reattaches to its runner rather than forcing the
user to create a replacement thread
([Runners](https://ampcode.com/manual#runners),
[Remote Control](https://ampcode.com/manual#remote-control)).

The Scotty pattern should be a small task-placement choice:

- `Cloud` means Scotty chooses an available hosted workspace provider.
- `Runner: <name>` means execute on a known user-controlled location.
- An automatic default can hide this choice until the user needs control.

The task card should show the selected location, but task navigation should not
be grouped primarily by machine. A location may disappear or be replaced while
the task remains useful.

## Per-task prompt and slice

Amp explicitly recommends one thread per task and asks users to supply known
files, commands, constraints, and review steps in the prompt. Orb creation also
selects a project, which supplies the repository and project configuration
([How to Prompt](https://ampcode.com/manual#how-to-prompt),
[Projects](https://ampcode.com/manual#projects)).

That suggests a compact Scotty creation sheet with:

- a task prompt;
- a project or repository;
- an optional execution location;
- optional starting context such as branch, files, or a previous session.

The prompt is the task boundary. Scotty should not require the user to create or
name a machine first. It can expose advanced runtime choices after the task
fields, and it should preserve the exact submitted prompt on the session so the
user can later understand why that workspace exists.

Amp's repository-per-project and fresh-clone behavior is not the reusable
contract. Scotty can choose a clone, worktree, snapshot, or resumed filesystem
per provider as long as the visible task slice stays explicit.

## Live steering

Amp distinguishes three user intentions while an agent is working:

- a normal message queues until the current agent turn finishes;
- `Enter` twice delivers the message after the current step, such as the active
  command or thinking block;
- `Esc` twice stops the agent and sends the message immediately
  ([Queueing Messages](https://ampcode.com/manual#queueing-messages)).

This is more useful than a single ambiguous "send" action. Scotty should model
these as durable command intents rather than keybindings:

- `After turn`
- `After current step`
- `Interrupt now`

The UI can keep ordinary Send mapped to `After turn`, then expose the other two
in a small send-menu or active-run control. Each submitted steer should show its
delivery state: queued, accepted for the next boundary, delivered, cancelled,
or failed. Amp's exact keyboard gestures need not carry over.

Remote control also demonstrates that steering and terminal attachment belong
to the same durable task even when the user changes device. Amp lets a user
open a running CLI thread on the web or mobile, continue sending messages, and
optionally access its terminal; the runner reattaches existing threads
([Remote Control](https://ampcode.com/manual#remote-control)).

## Status and readback

Amp makes the task workspace inspectable before it is synchronized locally.
From an orb thread, the user can review changes, browse files, open a terminal
in the agent's filesystem, or run `amp sync <thread-id>` while the remote agent
continues working
([Review & File Access](https://ampcode.com/manual/orbs#review--file-access),
[Terminal](https://ampcode.com/manual/orbs#terminal),
[`amp sync`](https://ampcode.com/manual/orbs#amp-sync)).

The shared terminal goes further: it runs in a tmux session shared with the
agent, so agent and user can see the same shell output. The reusable idea is
immediate workspace readback, not tmux. Scotty should keep these views attached
to each session:

- transcript and current turn;
- concise lifecycle/run status;
- changed files and diff;
- file browser;
- terminal attachment when the provider supports it;
- preview links when the task starts services.

The evidence does not establish a detailed Amp fleet-status model. Scotty
should not infer one. It needs its own small state vocabulary that separates
task status from execution status, for example `queued`, `working`,
`needs-input`, `done`, and `failed` for the task, plus `starting`, `online`,
`paused`, and `unavailable` for its location.

Amp auto-pauses an inactive orb after 15 minutes and pauses it immediately when
its thread is archived. A paused orb is not billed
([Orbs: Pricing](https://ampcode.com/manual/orbs#pricing)). The portable pattern
is that task lifecycle drives resource policy. The 15-minute value and Amp's
billing behavior are not portable.

## Identity and navigation

Amp exposes the thread ID as the durable reference. Users can mention another
thread by URL or ID, and Amp extracts relevant information into the current
task. Archived threads remain viewable and referenceable
([Referencing Other Threads](https://ampcode.com/manual#referencing-other-threads),
[Archiving Threads](https://ampcode.com/manual#archiving-threads)).

Its feed supports search by text plus `label`, `file`, `project`, `repo`, `ref`,
`author`, `archived`, `after`, and `before`, and the activity window can be
bookmarked in the URL
([Finding Threads](https://ampcode.com/manual#finding-threads)).

Scotty should therefore keep separate identifiers for:

- the user-facing session;
- the project/repository;
- the selected execution location;
- the provider's current workspace/runtime.

Only the first should appear in links, history, references, and navigation.
Provider workspace IDs belong in diagnostics. A useful session switcher should
start with active/recent tasks and support project, status, location, changed
file, and archived filters. Referencing a prior session should attach a
read-only context summary or selected artifacts; it should not implicitly
resume or share the prior runtime.

## Product shape to borrow

The smallest coherent Scotty version is:

1. A `New task` action accepts prompt, project, and optional location.
2. Creation immediately returns a stable session and opens it while placement
   and provisioning continue.
3. The session shows task status and location status separately.
4. Its composer supports queued, boundary, and interrupting steering.
5. Its tabs expose transcript, changes/files, and optional terminal/preview.
6. A global switcher searches sessions and returns to the same task from phone
   or desktop.

This preserves Amp Orbs' useful interaction model while leaving runtime
provisioning, filesystem strategy, terminal implementation, and provider
features replaceable.

## Sources

- Amp, [Orbs](https://ampcode.com/manual/orbs)
- Amp, [Owner's Manual](https://ampcode.com/manual)
