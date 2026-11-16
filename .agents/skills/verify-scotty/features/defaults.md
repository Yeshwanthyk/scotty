# Agent defaults and appearance

1. Record existing sessions with `scotty ls`; do not touch them.
2. Run `npm run --silent e2e -- defaults --real`. It saves/readbacks defaults, rejects invalid agent/model/effort, creates a scripted session with the omitted agent and a real session with an explicit agent, and checks the next real start's model/effort. It restores owner defaults in a finalizer and stops only its own sessions. Logs go to `work/defaults-<id>.json`.
3. In Settings → Defaults, note all original values. Edit agent, both models and efforts, Save, reload, and confirm the values. Restore and save the original values before creating unrelated sessions.
4. In a new session draft, check the saved default is selected. An explicit choice must survive a late defaults response. A failed defaults load must show an error and require an explicit choice. A default Claude without sign-in must not switch silently to Codex.
5. Choose Dark, reload, then Light, reload. Check page colors and selection. Choose System, change the browser's preferred scheme both ways and check it follows. Restore the browser's original appearance choice.
6. At 375 px wide, inspect every model/effort field and Save button; none may exceed the viewport. Capture desktop and mobile screenshots. Close only the test tab.
