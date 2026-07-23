# syntax=docker/dockerfile:1

# Keep this image version paired with @cloudflare/sandbox in worker/package.json.
FROM docker.io/cloudflare/sandbox:0.12.3@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042

ARG CODEX_VERSION=0.144.6

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends gh locales \
  && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
  && locale-gen \
  && npm install --global "@openai/codex@${CODEX_VERSION}" \
  && apt-get clean \
  && find /var/lib/apt/lists -mindepth 1 -delete

ENV LANG=en_US.UTF-8 \
  LC_ALL=en_US.UTF-8 \
  TERM=xterm-256color \
  GIT_TERMINAL_PROMPT=0

RUN mkdir -p /cache /workspace \
  && git clone --bare https://github.com/anomalyco/rift.git /cache/rift.git \
  && git -C /cache/rift.git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' \
  && git -C /cache/rift.git fetch --prune origin

COPY bootstrap.sh /usr/local/bin/scotty-bootstrap
COPY scotty-attach /usr/local/bin/scotty-attach
COPY sheppard-linux-amd64 /usr/local/bin/sheppard
RUN chmod 0755 /usr/local/bin/scotty-bootstrap /usr/local/bin/scotty-attach /usr/local/bin/sheppard \
  && echo "2502c634d3ce34cccc3d55c8573b52c6ba29a46b66404bde65374aeff302ee4b  /usr/local/bin/sheppard" | sha256sum --check --strict \
  && codex --version \
  && gh --version \
  && sheppard version \
  && git --version

# The SDK base image supplies /container-server/sandbox as its ENTRYPOINT.
