---- MODULE MacSignIn ----
\* The Mac app's Cloudflare Access sign-in (mac/src/main.rs, api.rs, live.rs, signin.rs).
\* `ui` is the chart variable: which screen the window shows (State::auth).
\*   "list" = Auth::Ready, "signin" = Auth::Needed, "waiting" = Auth::Waiting, "failed" = Auth::Failed.
\* `kc` is the Keychain entry for this origin (keychain::get/set/delete): 0 = none, else a token
\* number. `revoked` holds tokens Access now refuses (the owner's Access session ended).
\* Each r in Reqs is one network thread: an HTTP call (api::call) or a live socket (live::start).
\* Both read the token, send it, and on 302/401/403 call signin::refused, then report SignIn.
EXTENDS Naturals
CONSTANTS Reqs, MaxTok, Fix
VARIABLES ui, kc, nxt, revoked, req, signer, ghost, lost, bounced, reset
vars == <<ui, kc, nxt, revoked, req, signer, ghost, lost, bounced, reset>>

Good(t) == t # 0 /\ t \notin revoked

Init == /\ ui = "signin"          \* State::open: signin::token -> NoToken::SignIn -> Auth::Needed
        /\ kc = 0 /\ nxt = 1 /\ revoked = {}
        /\ req = [r \in Reqs |-> [st |-> "idle", tok |-> 0]]
        /\ signer = "none"        \* State::signing, as the sign-in thread's last word
        /\ ghost = FALSE          \* a cancelled sign-in thread still able to save its token
        /\ lost = FALSE /\ bounced = FALSE /\ reset = FALSE

\* State::sign_in. Fix: a good saved token (a cancelled thread saved one) goes straight in.
StartSignIn == /\ ui \in {"signin", "failed"} /\ signer = "none"
               /\ IF Fix /\ kc # 0
                  THEN ui' = "list" /\ UNCHANGED signer
                  ELSE ui' = "waiting" /\ signer' = "running"
               /\ UNCHANGED <<kc, nxt, revoked, req, ghost, lost, bounced, reset>>

\* signin::sign_in returns Ok after keychain::set (one step: the Keychain lock in the fix).
Finish == /\ signer = "running" /\ nxt <= MaxTok
          /\ kc' = nxt /\ nxt' = nxt + 1 /\ signer' = "ok"
          /\ UNCHANGED <<ui, revoked, req, ghost, lost, bounced, reset>>

\* signin::sign_in returns Err (app_info, transfer timeout, or Cancel seen between polls).
GiveUp == /\ signer = "running" /\ signer' = "err"
          /\ UNCHANGED <<ui, kc, nxt, revoked, req, ghost, lost, bounced, reset>>

\* A cancelled thread whose last long poll was already in flight still saves the token.
GhostFinish == /\ ghost /\ nxt <= MaxTok
               /\ kc' = nxt /\ nxt' = nxt + 1 /\ ghost' = FALSE
               /\ UNCHANGED <<ui, revoked, req, signer, lost, bounced, reset>>
GhostQuit == /\ ghost /\ ghost' = FALSE
             /\ UNCHANGED <<ui, kc, nxt, revoked, req, signer, lost, bounced, reset>>

\* State::poll_sign_in: Done(Ok) -> Ready and connect(); Done(Err) -> Failed.
LandOk == /\ signer = "ok" /\ ui = "waiting" /\ ui' = "list" /\ signer' = "none"
          /\ UNCHANGED <<kc, nxt, revoked, req, ghost, lost, bounced, reset>>
LandErr == /\ signer = "err" /\ ui = "waiting" /\ ui' = "failed" /\ signer' = "none"
           /\ UNCHANGED <<kc, nxt, revoked, req, ghost, lost, bounced, reset>>

\* State::cancel_sign_in drops Signing: its Drop sets the cancel flag, the receiver goes away.
Cancel == /\ ui = "waiting" /\ ui' = "signin" /\ signer' = "none"
          /\ ghost' = (ghost \/ signer = "running")
          /\ UNCHANGED <<kc, nxt, revoked, req, lost, bounced, reset>>

\* State::ask / connect / open_session start a thread only while Auth::Ready.
Ask(r) == /\ ui = "list" /\ req[r].st = "idle"
          /\ req' = [req EXCEPT ![r].st = "asked"]
          /\ UNCHANGED <<ui, kc, nxt, revoked, signer, ghost, lost, bounced, reset>>

\* api::request / live thread: signin::token. None saved -> SignIn without touching the Keychain.
Read(r) == /\ req[r].st = "asked"
           /\ req' = [req EXCEPT ![r] = IF kc = 0 THEN [st |-> "r401", tok |-> 0]
                                                  ELSE [st |-> "sent", tok |-> kc]]
           /\ UNCHANGED <<ui, kc, nxt, revoked, signer, ghost, lost, bounced, reset>>

\* Access answers. Refused: signin::refused deletes the Keychain entry. Current code: whatever is
\* saved now. Fix: only the token this thread sent (under the Keychain lock).
Serve(r) == /\ req[r].st = "sent"
            /\ IF req[r].tok \in revoked
               THEN /\ kc' = IF Fix THEN (IF kc = req[r].tok THEN 0 ELSE kc) ELSE 0
                    /\ req' = [req EXCEPT ![r].st = "r401"]
               ELSE /\ req' = [req EXCEPT ![r].st = "ok"] /\ UNCHANGED kc
            /\ lost' = (lost \/ (Good(kc) /\ kc' = 0))
            /\ UNCHANGED <<ui, nxt, revoked, signer, ghost, bounced, reset>>

\* State::poll lands the answer or Link::SignIn; a refusal calls need_sign_in, which acts only
\* while Ready. Fix: when a token is saved again, reconnect with it instead of signing out.
Land(r) == /\ req[r].st \in {"ok", "r401"}
           /\ req' = [req EXCEPT ![r] = [st |-> "idle", tok |-> 0]]
           /\ ui' = IF req[r].st = "r401" /\ ui = "list" /\ ~(Fix /\ kc # 0) THEN "signin" ELSE ui
           /\ bounced' = (bounced \/ (ui = "list" /\ ui' = "signin" /\ Good(kc)))
           /\ reset' = (reset \/ (ui \in {"waiting", "failed"} /\ ui' # ui))
           /\ UNCHANGED <<kc, nxt, revoked, signer, ghost, lost>>

\* The owner's Access session ends: Access refuses the saved token from now on.
Expire == /\ Good(kc) /\ revoked' = revoked \cup {kc}
          /\ UNCHANGED <<ui, kc, nxt, req, signer, ghost, lost, bounced, reset>>

Next == \/ StartSignIn \/ Finish \/ GiveUp \/ GhostFinish \/ GhostQuit
        \/ LandOk \/ LandErr \/ Cancel \/ Expire
        \/ \E r \in Reqs : Ask(r) \/ Read(r) \/ Serve(r) \/ Land(r)

\* Harm: you just signed in, and a reply to a request sent with your old token deletes the new one.
NoFreshTokenLost == ~lost
\* Harm: the app shows the sign-in screen while the Keychain holds a token Access accepts.
NoBounceWithGoodToken == ~bounced
\* Harm: a late refusal resets the screen while you are signing in in the browser.
SignInNotReset == ~reset
====
