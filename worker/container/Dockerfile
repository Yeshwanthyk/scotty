# syntax=docker/dockerfile:1

# Keep this image version paired with @cloudflare/sandbox in worker/package.json.
FROM docker.io/cloudflare/sandbox:0.12.3@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042 AS scotty-cli-build

WORKDIR /build
COPY package.json package-lock.json ./
COPY worker/package.json worker/package.json
COPY tui/package.json tui/package.json
COPY scripts/apply-dependency-patches.mjs scripts/apply-dependency-patches.mjs
COPY scripts/cloudflare-topology-data.mjs scripts/cloudflare-topology-data.mjs
COPY scripts/project-container-pi-install.mjs scripts/project-container-pi-install.mjs
COPY patches/alchemy+2.0.0-beta.67.patch patches/alchemy+2.0.0-beta.67.patch
COPY patches/earendil-works+pi-coding-agent+0.84.0.patch patches/earendil-works+pi-coding-agent+0.84.0.patch
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
RUN node scripts/apply-dependency-patches.mjs
COPY cli/scotty.ts cli/scotty.ts
COPY cli/src cli/src
COPY infra infra
COPY protocol protocol
COPY tui/src tui/src
COPY worker/src worker/src
COPY worker/container/toolsets/standard.json worker/container/toolsets/standard.json
RUN bun build cli/scotty.ts --compile --outfile /out/scotty \
  && chmod 0755 /out/scotty \
  && test "$(stat -c '%a' /out/scotty)" = "755" \
  && /out/scotty --version

FROM docker.io/cloudflare/sandbox:0.12.3@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042 AS scotty-package-image

ARG AST_GREP_VERSION=0.45.0
ARG COREPACK_VERSION=0.35.0
ARG FD_VERSION=10.4.2
ARG FD_SHA256=0e44eb5fca93f09bc6f5430b90acdf44c8e069d0a903700aeb4820629337b67b
ARG GO_VERSION=1.26.1
ARG GO_SHA256=031f088e5d955bab8657ede27ad4e3bc5b7c1ba281f05f245bcc304f327c987a
ARG PI_VERSION=0.84.0
ARG PLAYWRIGHT_VERSION=1.62.1
ARG PNPM_VERSION=11.11.0
ARG QSV_VERSION=21.1.0
ARG QSV_SHA256=6e1e322c2ac0d2e862e961f0bb5b30c8ceccb12ace37067bc8d911c77cf101f3
ARG RIPGREP_VERSION=15.2.0
ARG RIPGREP_SHA256=5af93eebe4c352474632cf1d28523b0e98bcd4e2f115a249a713b8d8c7d1d01c
ARG UV_VERSION=0.11.32
ARG UV_SHA256=aab924fd522efd06f1c5f3b93a243864fc453132c94b2dc49f1371b528a4b967
ARG YQ_VERSION=4.53.3
ARG YQ_SHA256=fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4

ENV COREPACK_HOME=/opt/corepack

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    gh \
    git \
    jq \
    locales \
    ffmpeg \
    pkg-config \
    shellcheck \
    unzip \
    xvfb \
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
    "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
    --output /tmp/go.tar.gz \
  && echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum --check --strict \
  && tar -xzf /tmp/go.tar.gz -C /usr/local \
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
    "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    "corepack@${COREPACK_VERSION}" \
  && corepack enable \
  && corepack install --global "pnpm@${PNPM_VERSION}" \
  && test "$(pnpm --version)" = "${PNPM_VERSION}" \
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
  GOTOOLCHAIN=auto \
  GOPROXY=https://proxy.golang.org \
  GOSUMDB=sum.golang.org \
  PATH=/usr/local/go/bin:${PATH} \
  PI_VERSION=${PI_VERSION} \
  PLAYWRIGHT_BROWSERS_PATH=/opt/scotty/playwright-browsers \
  UV_PYTHON_INSTALL_DIR=/opt/uv/python \
  UV_PYTHON_BIN_DIR=/usr/local/bin

RUN mkdir -p /workspace /opt/scotty/skills

COPY --from=scotty-cli-build /out/scotty /usr/local/bin/scotty
COPY worker/container/skills/THIRD_PARTY_NOTICES.md /opt/scotty/THIRD_PARTY_NOTICES.md
COPY worker/container/skills/skills.lock.json /opt/scotty/skills.lock.json
COPY worker/container/pi-packages /opt/scotty/pi-packages
COPY worker/container/toolsets/standard.json /opt/scotty/toolsets/standard.json
COPY worker/container/scotty-runner-bootstrap /usr/local/bin/scotty-runner-bootstrap
COPY worker/container/scotty-pi-shell /usr/local/bin/scotty-pi-shell
COPY worker/container/scotty-pi-session.mjs /usr/local/bin/scotty-pi-session
COPY worker/container/scotty-jsonl.mjs /usr/local/bin/scotty-jsonl.mjs
COPY worker/container/scotty-pi-protocol.mjs /usr/local/bin/scotty-pi-protocol.mjs
COPY protocol/pi-console-shared.mjs /usr/protocol/pi-console-shared.mjs
COPY scripts/project-container-pi-install.mjs /tmp/project-container-pi-install.mjs
RUN set -eu; \
  node /tmp/project-container-pi-install.mjs --pi-packages /opt/scotty/pi-packages \
  && npm ci \
      --prefix /opt/scotty/pi-packages/npm \
      --omit=dev \
      --ignore-scripts \
      --no-audit \
      --no-fund \
      --legacy-peer-deps \
  && for package_dir in /opt/scotty/pi-packages/sources/*; do \
    test -f "${package_dir}/package.json"; \
    test -f "${package_dir}/package-lock.json"; \
    npm ci \
        --prefix "${package_dir}" \
        --omit=dev \
        --ignore-scripts \
        --no-audit \
        --no-fund \
        --legacy-peer-deps; \
  done \
  && node /tmp/project-container-pi-install.mjs --assert-image --pi-packages /opt/scotty/pi-packages \
  && rm -f /tmp/project-container-pi-install.mjs \
  && test "$(node --input-type=module -e "import('/opt/scotty/pi-packages/sources/scotty-browser-test/node_modules/playwright-core/package.json', { with: { type: 'json' } }).then(({ default: packageJson }) => process.stdout.write(packageJson.version))")" = "${PLAYWRIGHT_VERSION}" \
  && node \
    /opt/scotty/pi-packages/sources/scotty-browser-test/node_modules/playwright-core/cli.js \
    install --with-deps chromium \
  && test -z "$(find /opt/scotty/pi-packages/sources -mindepth 2 -maxdepth 2 -name .git -print -quit)" \
  && chmod 0755 \
    /usr/local/bin/scotty-runner-bootstrap \
    /usr/local/bin/scotty-pi-shell \
    /usr/local/bin/scotty-pi-session \
  && chmod -R a-w /opt/scotty/pi-packages /opt/scotty/playwright-browsers /opt/scotty/skills \
  && npm cache clean --force \
  && rm -rf /root/.cache /tmp/* \
  && apt-get clean \
  && find /var/lib/apt/lists -mindepth 1 -delete

FROM scotty-package-image

EXPOSE 43117

RUN set -eu; \
  mkdir -p /tmp/scotty-pi-agent \
  && cp /opt/scotty/pi-packages/settings.json /tmp/scotty-pi-agent/settings.json \
  && PI_CODING_AGENT_DIR=/tmp/scotty-pi-agent PI_OFFLINE=1 pi list >/tmp/scotty-pi-packages.list \
  && PI_CODING_AGENT_DIR=/tmp/scotty-pi-agent PI_OFFLINE=1 pi --offline --help >/tmp/scotty-pi-help \
  && grep -F -- "--plan" /tmp/scotty-pi-help >/dev/null \
  && test ! -d /tmp/scotty-pi-agent/git \
  && test ! -d /tmp/scotty-pi-agent/npm \
  && if grep -F -- "pi-tasks" /tmp/scotty-pi-packages.list >/dev/null; then \
    echo "unexpected pi-tasks" >&2; \
    exit 1; \
  else \
    grep_status=$?; \
    test "${grep_status}" -eq 1; \
  fi \
  && test ! -e /opt/scotty/pi-packages/sources/pi-tasks \
  && for package_name in \
    pi-workflows \
    pi-background-terminals \
    pi-askuser \
    pi-web-access \
    pi-amp-ui; do \
      if grep -F -- "${package_name}" /tmp/scotty-pi-packages.list >/dev/null; then \
        echo "unexpected ${package_name}" >&2; \
        exit 1; \
      fi; \
      test ! -e "/opt/scotty/pi-packages/sources/${package_name}"; \
    done \
  && for package_name in \
    pi-subagents \
    @ogulcancelik/pi-codex-compaction \
    scotty-browser-test \
    scotty-hatch; do \
      grep -F -- "${package_name}" /tmp/scotty-pi-packages.list >/dev/null || exit 1; \
    done \
  && rm -rf /tmp/scotty-pi-agent /tmp/scotty-pi-help /tmp/scotty-pi-packages.list \
  && shellcheck /usr/local/bin/scotty-runner-bootstrap /usr/local/bin/scotty-pi-shell \
  && test "$(find /opt/scotty/skills -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 0 \
  && test "$(stat -c '%a' /usr/local/bin/scotty)" = "755" \
  && test -z "$(find /opt/scotty/pi-packages /opt/scotty/playwright-browsers /opt/scotty/skills ! -type l -perm /222 -print -quit)" \
  && test "$(pi --version)" = "${PI_VERSION}" \
  && scotty tools list --json >/dev/null \
  && for command_name in \
    rg fd ast-grep jq yq qsv uv uvx python go gofmt git gh shellcheck ffmpeg Xvfb \
    node npm bun corepack cc pkg-config pi scotty-pi-session scotty-pi-shell scotty-runner-bootstrap; do \
      command -v "${command_name}" >/dev/null || exit 1; \
    done \
  && if command -v codex >/dev/null; then exit 1; fi \
  && rm -rf /root/.cache /root/.npm /tmp/*

# The SDK base image supplies /container-server/sandbox as its ENTRYPOINT.
