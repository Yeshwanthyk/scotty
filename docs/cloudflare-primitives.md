# How Scotty Uses Cloudflare

Scotty gives a Codex coding session a temporary computer in the cloud. You can
start it from the CLI, watch and control it in a browser terminal, let it sleep,
restore it later, publish its work, or delete it permanently.

This guide explains the Cloudflare parts behind that experience in simple
language.

> [!NOTE]
> This describes the current architecture: one public, Alchemy-managed
> Cloudflare Worker. A possible future split into separate API and Sandbox
> Workers is not part of the current system.

## The whole system at a glance

```text
                         DEPLOY TIME
                    +-------------------+
                    |      Alchemy      |
                    | creates/updates   |
                    | Cloudflare pieces |
                    +---------+---------+
                              |
                              v

 CLI or browser
      |
      | HTTPS or WebSocket
      v
+------------------------------------------------------------------+
|                    CLOUDFLARE WORKER                              |
|                                                                  |
|  Scotty's public front door                                      |
|  - checks who is allowed in                                      |
|  - handles API and CLI commands                                  |
|  - serves the web interface                                      |
|  - carries live terminal traffic                                 |
|  - guards the Container's internet access                        |
+----------+-------------------------+---------------------+--------+
           |                         |                     |
           v                         v                     v
 +------------------+      +-------------------+    +--------------+
 | Static Assets    |      | Auth Durable     |    | Sessions KV  |
 |                  |      | Object            |    |              |
 | terminal page    |      |                   |    | quick session|
 | sessions page    |      | paired browsers   |    | and repo     |
 | devices/pair UI  |      | revoked browsers  |    | lists        |
 | JavaScript/WASM  |      | one-use tickets   |    | may be stale |
 +------------------+      +-------------------+    +--------------+


 For every Scotty session ID:

 +----------------------------------------------------------------+
 | SANDBOX DURABLE OBJECT - THE SESSION'S BRAIN                    |
 |                                                                |
 | Source of truth for:                                           |
 | - session status and current operation                         |
 | - hard time limit and scheduled cleanup                        |
 | - backup references                                            |
 | - real Codex and GitHub credentials                            |
 | - terminal attachment leases                                   |
 +----------------------+----------------------+------------------+
                        |                      |
                        v                      v
            +----------------------+   +--------------------------+
            | R2 backup bucket     |   | Cloudflare Container     |
            |                      |   |                          |
            | workspace snapshots  |   | temporary Linux computer|
            | restore after sleep  |   | Codex + git + Sheppard  |
            +----------------------+   | repository worktree      |
                                       | fake credentials only    |
                                       +------------+-------------+
                                                    |
                           +------------------------+--------------+
                           |                                       |
                           v                                       v
                 Native terminal PTY                    Guarded internet
                           |                                       |
                           v                                       v
                 Worker WebSocket bridge                  Egress proxy
                           |                             real credentials
                           v                             added only here
                        Browser
```

## A short mental model

```text
Worker       = the front door
Auth DO      = the guest list
Session DO   = the session's brain and safe
Container    = a temporary development computer
Sandbox SDK  = the remote control for that computer
KV           = a fast, possibly stale index
R2           = the backup shelf
WebSocket    = the live terminal cable
Egress proxy = the credential security guard
Alchemy      = the infrastructure installer
```

## Cloudflare Worker: the front door

### What it does

A Cloudflare Worker runs code when an internet request arrives.

### How Scotty uses it

Scotty has one public Worker. It:

- receives commands from the Scotty CLI;
- handles the HTTP API;
- checks browser and CLI authentication;
- serves protected web pages;
- connects browsers to terminal WebSockets;
- forwards work to the correct Durable Object; and
- controls outbound requests from Containers.

### Why we use it

We need one secure entry point for every way a person interacts with Scotty.
The Worker is fast to start and does not require us to maintain a traditional
web server.

> [!IMPORTANT]
> The Worker is a front door, not a database. A Worker request may end at any
> time, so lasting session state belongs in Durable Object storage.

## Static Assets: the web interface files

### What they do

Cloudflare Static Assets serves files such as HTML, JavaScript and WebAssembly.

### How Scotty uses them

The `ASSETS` binding serves:

- the browser terminal;
- the sessions page;
- device and pairing pages;
- the terminal JavaScript; and
- the bundled `ghostty-web` terminal files.

Protected pages still pass through the Worker first so Scotty can check
authentication.

### Why we use them

These files do not need their own server. They can be deployed beside the
Worker and delivered directly by Cloudflare.

## Session Durable Object: the session's brain

### What it does

A Durable Object combines code with strongly consistent storage. Requests for
the same object are coordinated through that object.

### How Scotty uses it

Every session ID maps to one Sandbox Durable Object. It owns:

- the authoritative session status;
- the current operation lock;
- creation, sleep, resume and destruction decisions;
- the hard time limit and scheduled callbacks;
- the current and previous backup references;
- the real Codex and GitHub credential bundle;
- OAuth refresh coordination; and
- terminal attachment leases.

If two commands try to change the same session, the Durable Object makes sure
they cannot both win.

### Why we use it

A coding session has state that must be correct. For example, `resume` must not
race with `vaporize`, and a stale session list must not bring back a deleted
Container. The Durable Object gives each session one reliable decision-maker.

```text
          snapshot
             |
             v
       +-------------+
       | Session DO  | <----- resume / sleep / publish / delete
       | source of   |
       | truth       |
       +------+------+
              |
              +---- decides what happens next
```

## Auth Durable Object: the guest list

### What it does

This is a second Durable Object with a different job: deciding which browsers
may use Scotty.

### How Scotty uses it

One shared Auth Durable Object stores:

- registered browsers;
- revoked browsers;
- short-lived pairing grants; and
- short-lived, one-use terminal tickets.

It stores hashes of browser credentials, not the original secret values.

### Why we use it

Authentication must stay consistent across every session. Keeping it separate
also means deleting one coding session cannot accidentally delete the browser
guest list.

## Cloudflare Container: the temporary computer

### What it does

A Cloudflare Container runs a Linux environment from Scotty's Docker image.

### How Scotty uses it

An active session gets a Container runtime containing:

- Codex;
- `git` and the GitHub CLI;
- Sheppard, which keeps the Codex terminal process alive;
- the repository worktree; and
- normal build and test tools.

The Container edits files and runs commands. Its filesystem is disposable.

### Why we use it

Codex needs more than a small request handler. It needs a real development
computer where it can clone repositories, run tests and keep an interactive
terminal alive.

```text
Durable Object                         Container

remembers the session         controls        runs the work
       +--------------------------->+------------------------+
       |                            | Codex, git, tests      |
       |<---------------------------| command results        |
       +----------------------------+------------------------+
          durable                     disposable
```

## Sandbox SDK: the remote control

### What it does

The official Cloudflare Sandbox SDK connects a Sandbox Durable Object to its
Container.

### How Scotty uses it

It lets Scotty:

- run commands;
- read and write files;
- create named terminal sessions;
- open the native terminal PTY;
- create and restore backups;
- schedule future callbacks;
- stop or destroy a Container; and
- intercept outbound HTTPS requests.

Scotty uses the SDK's RPC API for session commands.

### Why we use it

The Durable Object needs a safe, supported way to control the Linux computer.
The SDK supplies that control layer so Scotty does not have to build its own
container protocol.

## KV: the quick index

### What it does

Workers KV is a globally distributed key-value store optimized for fast reads.
Updates may take time to appear everywhere.

### How Scotty uses it

The `SESSIONS` namespace stores non-secret summaries for:

- the sessions list; and
- the recently used repositories list.

A session Durable Object updates KV after it changes the real session record.
If the KV update fails or arrives late, the session itself remains correct.

### Why we use it

Listing many sessions should be quick. Asking every individual Durable Object
for its state would be slower and more complicated.

```text
Session DO -- best-effort copy --> KV -- fast read --> Sessions page
    |
    +-- real decisions happen here

KV may lag. KV never approves a state change.
```

## R2: the backup shelf

### What it does

R2 is Cloudflare's object storage for larger files.

### How Scotty uses it

Scotty stores immutable workspace backups in the `scotty-backups` bucket.
Before a session sleeps, Scotty:

1. pauses the managed Codex process;
2. flushes filesystem changes;
3. uploads a new backup to R2;
4. records that backup as current in the session Durable Object; and
5. stops the Container.

Resume performs the reverse: start a fresh Container, restore the Durable
Object's chosen R2 backup, restore the fake credentials and continue Codex.

### Why we use it

Containers can stop and their files are not the source of truth. R2 lets Scotty
recover the repository and Codex rollout files later.

> [!IMPORTANT]
> R2 holds the backup bytes, but the session Durable Object decides which
> backup is current. A backup never contains real Codex or GitHub credentials.

## WebSockets and native PTY: the live terminal cable

### What they do

A WebSocket keeps a two-way connection open. A PTY behaves like a real terminal.

### How Scotty uses them

The browser gets a one-use terminal ticket. The Worker checks that ticket,
opens a named Sandbox terminal, and bridges the Sandbox WebSocket to the
browser.

```text
keyboard input
Browser ========= WebSocket ========= Worker ========= Sandbox PTY
        <===============================================
                         terminal output
```

Each browser gets its own terminal view. Disconnecting a browser does not kill
the managed Codex process.

### Why we use them

A terminal needs continuous, low-latency communication. Making a new HTTP
request for every keypress would not work well.

## Worker Secrets, sentinels and the egress proxy

These three pieces work together to protect credentials.

### Worker Secrets: the initial locked drawer

Cloudflare Worker Secrets provide the initial:

- `SCOTTY_TOKEN`;
- Codex authentication bundle; and
- GitHub token.

They are installed outside the source code. When a session is first created,
its real Codex and GitHub credentials are stored in that session's Durable
Object. Existing session credentials are not overwritten by a later seed.

### Sentinels: safe fake credentials

The Container never receives the real tokens. It gets random, session-bound
sentinel values that look like:

```text
scotty-codex-<session-and-random-data>
scotty-github-<session-and-random-data>
```

Seeing or stealing one of these values is not enough to access OpenAI or
GitHub directly.

### Egress proxy: the security guard

The Sandbox blocks general internet access and intercepts outbound HTTPS.
For each request, the proxy checks the destination and the sentinel.

```text
Container
   |
   | request carrying a sentinel
   v
+---------------------+
| Egress proxy        |
|                     |
| known destination?  |---- no ----> 403 DENY
| correct sentinel?   |---- no ----> 403 DENY
+----------+----------+
           |
          yes
           |
           v
 Read real token from the exact session DO
           |
           v
 Add token to this one approved request
           |
           +--------> OpenAI or GitHub
```

Package and download hosts may receive requests without credentials. Requests
to those hosts are rejected if they carry authorization headers or cookies.
Unknown destinations are denied.

### Why we use this design

Repository code is untrusted. It may inspect its environment, read files or run
unexpected commands. Even if it reads everything in the Container, it should
find only useless sentinels—not the real credentials.

OAuth rotation also happens in the proxy. A refreshed token is saved to the
session Durable Object before the Container receives a sentinel-only success
response.

## Scheduled callbacks: the alarm clock

### What they do

The Sandbox SDK can ask a session Durable Object to run a named callback later.

### How Scotty uses them

Scheduled callbacks handle:

- the session hard time limit;
- delayed Codex thread discovery;
- terminal attachment expiry;
- managed stop completion; and
- retries for destructive cleanup.

Idle Containers also trigger `onActivityExpired()`, which checkpoints the
workspace before stopping.

### Why we use them

Cleanup must happen even when no browser or CLI is sending requests. A session
with an open terminal must still respect its hard time limit.

## Alchemy: the infrastructure installer

### What it does

Alchemy describes and deploys Cloudflare infrastructure.

### How Scotty uses it

Alchemy creates and connects:

- the public Worker;
- both Durable Object classes;
- the Container application;
- the KV namespace;
- the R2 bucket;
- Static Assets; and
- the Worker bindings between them.

Persistent resources use retention rules. Secret bindings are inherited by
name so plaintext secret values do not enter Alchemy plans or state.

### Why we use it

The infrastructure should be repeatable and reviewable. Alchemy gives the
project one deployment model instead of a collection of manual setup steps.

> [!NOTE]
> Alchemy manages infrastructure, not live sessions. It never replaces Durable
> Object storage as the source of truth.

## What is authoritative?

This distinction is the most important part of the design.

| Location               | What belongs there                                                         |        Can it make session decisions?         |
| ---------------------- | -------------------------------------------------------------------------- | :-------------------------------------------: |
| Session Durable Object | Session state, operation lock, backup references, real session credentials |                      Yes                      |
| Auth Durable Object    | Browser registrations, revocation, pairing and terminal tickets            |            Yes, for authentication            |
| KV                     | Non-secret session and repository summaries                                |                      No                       |
| R2                     | Workspace backup bytes                                                     | No; the session DO chooses the current backup |
| Container filesystem   | The currently running worktree and Codex files                             |             No; it is disposable              |
| Worker memory          | Data needed only for the current request                                   |                      No                       |
| Alchemy state          | Cloudflare infrastructure metadata                                         |                      No                       |

## A session's lifecycle

```text
 CREATE
   Worker -> session DO writes "booting"
          -> save real credentials in the DO
          -> start Container
          -> prepare worktree and start Codex
          -> session DO writes "warm"
          -> copy non-secret summary to KV


 SNAPSHOT / IDLE / HARD LIMIT
   pause Codex
       -> flush files
       -> upload backup to R2
       -> commit new backup reference in session DO
       -> update KV summary
       -> resume Codex, or stop Container


 RESUME
   session DO reads its current backup reference
       -> start a fresh Container
       -> restore files from R2
       -> write sentinel credentials
       -> resume Codex
       -> session DO writes "warm"


 VAPORIZE
   cancel scheduled work
       -> destroy Container
       -> delete the session's R2 backup objects
       -> delete its real credential bundle
       -> remove its KV summary
       -> keep a small "gone" tombstone in the session DO
```

## Cloudflare products Scotty does not use in v1

Scotty deliberately keeps the first version small. It does **not** use:

- D1;
- Queues;
- Workflows;
- Cloudflare Access;
- wildcard session subdomains; or
- public Container preview ports.

## One-minute explanation

If you need to explain Scotty to someone else, use this:

> The Worker is the front door. One Auth Durable Object keeps the browser guest
> list, and every coding session has its own Durable Object that acts as its
> brain. That brain controls a disposable Linux Container where Codex actually
> works. KV provides a quick session list, while R2 holds workspace backups.
> The Container sees fake credentials only; a guarded proxy adds real
> credentials to approved OpenAI or GitHub requests. Alchemy installs and
> updates all of the Cloudflare infrastructure.

## Where to look in the repository

- Infrastructure topology: [`spikes/infra/monolith-greenfield.ts`](../spikes/infra/monolith-greenfield.ts)
- Public Worker and routes: [`worker/src/index.ts`](../worker/src/index.ts)
- Session Durable Object: [`worker/src/session.ts`](../worker/src/session.ts)
- Auth Durable Object: [`worker/src/auth-object.ts`](../worker/src/auth-object.ts)
- KV session projection: [`worker/src/session-projection.ts`](../worker/src/session-projection.ts)
- R2 backup adapter: [`worker/src/backup-store.ts`](../worker/src/backup-store.ts)
- Credential vault: [`worker/src/credential-vault.ts`](../worker/src/credential-vault.ts)
- Egress security: [`worker/src/egress.ts`](../worker/src/egress.ts)
- Alchemy entry point: [`alchemy.run.ts`](../alchemy.run.ts)
- Binding and migration fallback: [`worker/wrangler.jsonc`](../worker/wrangler.jsonc)
