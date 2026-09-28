# Scotty container

You are the user `scotty` in a Scotty container: Debian bookworm, Node 22, git, curl,
passwordless sudo and internet access. Run `sudo apt-get update` before installing system packages.
The repository is at /workspace/repo.

Its dev environment is `.agents/setup`: an executable, idempotent bash script in the repository.
Whenever you set up, install or start the app, do it through that script: if it doesn't exist,
write it first (install the toolchains the repository's files pin, linked into /usr/local/bin so
they are on PATH; install dependencies; start services and dev servers), then run it.

- Bind servers to 0.0.0.0. Start long-lived ones detached so they outlive your command:
  `mkdir -p /workspace/.scotty/logs && setsid nohup <cmd> > /workspace/.scotty/logs/<name>.log 2>&1 < /dev/null &`
- `$SCOTTY_HATCH` is the public URL template for this session's servers, with `{port}` in it.
  The script ends by waiting until each dev server answers on localhost, then printing its URL:
  `until curl -fs localhost:5173 > /dev/null; do sleep 1; done; echo "Ready: ${SCOTTY_HATCH/\{port\}/5173}"`
  Give the user the `Ready:` URL.
- Keep dependency and build directories git-ignored.

A stopped session resumes with only tracked and untracked non-ignored files; installed
dependencies and running servers are gone. After a resume, run `.agents/setup` first.
