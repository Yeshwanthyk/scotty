# syntax=docker/dockerfile:1

# Keep this image version paired with @cloudflare/sandbox in worker/package.json.
FROM docker.io/cloudflare/sandbox:0.12.3@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042 AS scotty-cli-build

WORKDIR /build
COPY package.json package-lock.json ./
COPY worker/package.json worker/package.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY cli/scotty.ts cli/scotty.ts
COPY worker/container/toolsets/standard.json worker/container/toolsets/standard.json
RUN bun build cli/scotty.ts --compile --outfile /out/scotty \
  && /out/scotty --version

FROM docker.io/cloudflare/sandbox:0.12.3@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042

ARG AST_GREP_VERSION=0.45.0
ARG CODEX_VERSION=0.144.6
ARG COREPACK_VERSION=0.35.0
ARG FD_VERSION=10.4.2
ARG FD_SHA256=0e44eb5fca93f09bc6f5430b90acdf44c8e069d0a903700aeb4820629337b67b
ARG QSV_VERSION=21.1.0
ARG QSV_SHA256=6e1e322c2ac0d2e862e961f0bb5b30c8ceccb12ace37067bc8d911c77cf101f3
ARG RIPGREP_VERSION=15.2.0
ARG RIPGREP_SHA256=5af93eebe4c352474632cf1d28523b0e98bcd4e2f115a249a713b8d8c7d1d01c
ARG UV_VERSION=0.11.32
ARG UV_SHA256=aab924fd522efd06f1c5f3b93a243864fc453132c94b2dc49f1371b528a4b967
ARG YQ_VERSION=4.53.3
ARG YQ_SHA256=fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    gh \
    git \
    jq \
    locales \
    pkg-config \
    shellcheck \
    tmux \
    unzip \
  && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
  && locale-gen \
  && curl --fail --location --silent --show-error \
    "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep_${RIPGREP_VERSION}-1_amd64.deb" \
    --output /tmp/ripgrep.deb \
  && echo "${RIPGREP_SHA256}  /tmp/ripgrep.deb" | sha256sum --check --strict \
  && dpkg --install /tmp/ripgrep.deb \
  && curl --fail --location --silent --show-error \
    "https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd_${FD_VERSION}_amd64.deb" \
    --output /tmp/fd.deb \
  && echo "${FD_SHA256}  /tmp/fd.deb" | sha256sum --check --strict \
  && dpkg --install /tmp/fd.deb \
  && curl --fail --location --silent --show-error \
    "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_amd64" \
    --output /usr/local/bin/yq \
  && echo "${YQ_SHA256}  /usr/local/bin/yq" | sha256sum --check --strict \
  && chmod 0755 /usr/local/bin/yq \
  && curl --fail --location --silent --show-error \
    "https://github.com/jqnatividad/qsv/releases/download/${QSV_VERSION}/qsv-${QSV_VERSION}-x86_64-unknown-linux-musl.zip" \
    --output /tmp/qsv.zip \
  && echo "${QSV_SHA256}  /tmp/qsv.zip" | sha256sum --check --strict \
  && unzip -j /tmp/qsv.zip qsv -d /usr/local/bin \
  && chmod 0755 /usr/local/bin/qsv \
  && curl --fail --location --silent --show-error \
    "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" \
    --output /tmp/uv.tar.gz \
  && echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum --check --strict \
  && tar -xzf /tmp/uv.tar.gz -C /tmp \
  && install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /usr/local/bin/uv \
  && install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/uvx \
  && npm install --global --ignore-scripts --no-audit --no-fund \
    "@ast-grep/cli@${AST_GREP_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
    "corepack@${COREPACK_VERSION}" \
  && corepack enable \
  && UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_PYTHON_BIN_DIR=/usr/local/bin \
    uv python install 3.13.13 --default --managed-python --no-cache --no-progress \
  && npm cache clean --force \
  && rm -rf /root/.cache /tmp/* \
  && apt-get clean \
  && find /var/lib/apt/lists -mindepth 1 -delete

ENV LANG=en_US.UTF-8 \
  LC_ALL=en_US.UTF-8 \
  TERM=xterm-256color \
  GIT_TERMINAL_PROMPT=0 \
  UV_PYTHON_INSTALL_DIR=/opt/uv/python \
  UV_PYTHON_BIN_DIR=/usr/local/bin

RUN mkdir -p /cache /workspace \
  && git clone --bare https://github.com/anomalyco/rift.git /cache/rift.git \
  && git -C /cache/rift.git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' \
  && git -C /cache/rift.git fetch --prune origin

COPY --from=scotty-cli-build /out/scotty /usr/local/bin/scotty
COPY worker/container/skills/bundled /opt/scotty/skills
COPY worker/container/skills/licenses /opt/scotty/licenses
COPY worker/container/skills/THIRD_PARTY_NOTICES.md /opt/scotty/THIRD_PARTY_NOTICES.md
COPY worker/container/skills/skills.lock.json /opt/scotty/skills.lock.json
COPY worker/container/toolsets/standard.json /opt/scotty/toolsets/standard.json
COPY worker/container/bootstrap.sh /usr/local/bin/scotty-bootstrap
COPY worker/container/scotty-attach /usr/local/bin/scotty-attach
COPY worker/container/sheppard-linux-amd64 /usr/local/bin/sheppard
RUN chmod 0755 \
    /usr/local/bin/scotty \
    /usr/local/bin/scotty-bootstrap \
    /usr/local/bin/scotty-attach \
    /usr/local/bin/sheppard \
  && chmod -R a-w /opt/scotty/skills \
  && echo "2502c634d3ce34cccc3d55c8573b52c6ba29a46b66404bde65374aeff302ee4b  /usr/local/bin/sheppard" | sha256sum --check --strict \
  && test "$(find /opt/scotty/skills -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 23 \
  && scotty tools list --json >/dev/null \
  && for command_name in \
    rg fd ast-grep jq yq qsv uv uvx python git gh tmux shellcheck \
    node npm bun corepack cc pkg-config codex sheppard; do \
      command -v "${command_name}" >/dev/null || exit 1; \
    done

# The SDK base image supplies /container-server/sandbox as its ENTRYPOINT.
