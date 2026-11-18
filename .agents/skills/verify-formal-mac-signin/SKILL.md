---
name: verify-formal-mac-signin
description: Model-check the native Mac app's Cloudflare Access sign-in (TLA+ with TLC) — the sign-in screen's states, the background sign-in thread, and the request and socket threads that read and delete the Keychain token. Run after any change to mac/src/signin.rs, mac/src/api.rs request/call, mac/src/live.rs connect/run, or the sign-in parts of mac/src/main.rs (Auth, Signing, open, connect, need_sign_in, sign_in, cancel_sign_in, poll_sign_in, close, poll).
---

# Verify the Mac sign-in formally

`MacSignIn.tla` models one window's sign-in against one Scotty. Every step it treats as atomic is
atomic in the code: one call on the UI thread, or one Keychain write under the `KEYCHAIN` lock.

## Scope

Sync: the working tree on top of `e6d80b83` (2026-11-07). `mac/` was not yet committed then;
move this to the commit that lands it once you confirm the model still describes the code.

| Model                       | Code                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `ui`                        | `State::auth` (`Ready` = `list`, `Needed` = `signin`, `Waiting` = `waiting`, `Failed` = `failed`) |
| `kc`                        | the Keychain entry for the origin (`signin::keychain`)                                            |
| `revoked`                   | tokens Access refuses (the owner's Access session ended)                                          |
| `StartSignIn`               | `State::sign_in` (a saved sign-in goes straight in)                                               |
| `Finish` / `GiveUp`         | `signin::sign_in` returning Ok after `keychain::set` under `KEYCHAIN`, or Err                     |
| `GhostFinish` / `GhostQuit` | a cancelled sign-in thread whose last long poll was already out                                   |
| `LandOk` / `LandErr`        | `State::poll_sign_in`                                                                             |
| `Cancel`                    | `State::cancel_sign_in` (dropping `Signing` sets its cancel flag)                                 |
| `Ask(r)`                    | `State::ask`, `State::connect`, `State::open_session`: only while `Auth::Ready`                   |
| `Read(r)`                   | `signin::token` in `api::request` and in the `live` thread                                        |
| `Serve(r)`                  | Access answering; on 302/401/403 `signin::refused(base, sent)`                                    |
| `Land(r)`                   | `poll` landing a 401 answer or `Link::SignIn`, then `State::need_sign_in`                         |
| `Expire`                    | the owner's Access session ending                                                                 |

Not modeled: `close`/`switch` to another Scotty (they drop `Signing` and every socket), local
token expiry (`signin::expired`, treated like an empty Keychain), and loopback servers (no token).

## Property

- `NoFreshTokenLost`: a refusal never deletes a token Access still accepts. Harm: you sign in and
  the app throws the new sign-in away.
- `NoBounceWithGoodToken`: the window never goes from your sessions to the sign-in screen while
  the Keychain holds a token Access accepts. Harm: asked to sign in while signed in.
- `SignInNotReset`: a late refusal never moves the screen while you sign in or after a failure.
  Harm: the sign-in screen resets while the browser is open.
- Deadlock: some step is always possible.

Reach: every trace with 2 network threads (`Reqs`) and 3 sign-ins (`MaxTok`), about 3,100 states.
Assumes the UI thread runs `poll` and button handlers one at a time, as Rune does.

## Run

```sh
.agents/skills/verify-formal-mac-signin/run.sh     # ~10 s; exit 0 = every rule holds
```

Needs Java 17+ and Python 3. `tlc_chart.py` (`tlc_chart 3 (TLC 1.7.4)`, copied from the invariants
skill) downloads `tla2tools.jar` 1.7.4 and checks its sha256. `MacSignInBefore.cfg` is the code
before the race fix: `run.sh --config MacSignInBefore.cfg -o /tmp/before.viz` must stay red on
`NoFreshTokenLost` (10 steps) and `NoBounceWithGoodToken` (11 steps).

## Chart

`chart.viz` holds the intended stories, drawn before modeling. A run writes `chart.checked.viz`
next to it (not kept): plain = works, `!` = a rule breaks, `?` = unreached, plus every step the
model takes that the chart has no arrow for. Every story works on the current code, and the harm
nodes are never reached.

## Read the result

Each trace step names an action; the Scope table gives its code. Replay a trace by walking
those calls in order. When a step can't happen in the code (a lock, a guard, an ordering the
model missed), the model is wrong: fix it and say what was wrong. When every step can happen, it
is a product defect.

## Linked tests

None. The interleavings cross the Keychain, the network and the UI thread, and the repo proves
the Mac app by driving it (`verify-scotty-mac`, `features/servers.md`). A live replay needs an
Access session that ends while a request is out, which only the owner can arrange.

## Update

When a change alters sign-in behavior on purpose, change the model in the same change, run it,
make a scratch break of the new code (and the matching model line) and see the rule go red, then
restore. A pass on a model that wasn't updated proves nothing about the new code.

## Known findings

None on the current code. Fixed on 2026-11-07, before the Mac app was committed:

1. A refusal deleted whatever token was saved, even one saved after the refused request went out
   (`signin::refused` now deletes only the token it sent, under `KEYCHAIN`).
2. A late refusal signed the window out while a newer token was saved (`need_sign_in` now
   reconnects when a sign-in is saved).
3. A sign-in that finished as you pressed Cancel was saved but unused (`State::sign_in` now goes
   straight in with a saved sign-in).
