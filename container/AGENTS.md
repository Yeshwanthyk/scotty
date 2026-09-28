# Scotty container

You are the user `scotty` in a Scotty container: Debian bookworm, Node 22, git, curl,
passwordless sudo and internet access. Run `sudo apt-get update` before installing system packages.
The repository is at /workspace/repo.

Its dev environment is `.agents/setup`: an executable, idempotent bash script in the repository.
Whenever you set up, install or start the app, do it through that script: if it doesn't exist,
write it first, then run it. The script does, in order:

1. Install the toolchains the repository's files pin, linked into /usr/local/bin so they are on PATH.
2. Install dependencies.
3. Start services and dev servers bound to 0.0.0.0, detached so they outlive the script:
   `mkdir -p /workspace/.scotty/logs && setsid nohup <cmd> > /workspace/.scotty/logs/<name>.log 2>&1 < /dev/null &`
4. Always last, even when the servers were already running: wait until each dev server answers on
   localhost, then print its public URL. `$SCOTTY_HATCH` is the URL template, with `{port}` in it:
   `until curl -fs localhost:5173 > /dev/null; do sleep 1; done; echo "Ready: ${SCOTTY_HATCH/\{port\}/5173}"`

Give the user the `Ready:` URL.

- Keep dependency and build directories git-ignored.

A stopped session resumes with only tracked and untracked non-ignored files; installed
dependencies and running servers are gone. After a resume, run `.agents/setup` first.
