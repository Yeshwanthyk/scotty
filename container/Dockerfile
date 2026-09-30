FROM oven/bun:1.3.13 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY ui/package.json ./ui/package.json
RUN bun install --frozen-lockfile --no-save --ignore-scripts
COPY container/supervisor ./container/supervisor
COPY protocol/supervisor.ts ./protocol/supervisor.ts
RUN bun build --compile container/supervisor/main.ts --outfile /out/scotty-sup
COPY container/scripted ./container/scripted
RUN bun build --compile container/scripted/codex.ts --outfile /out/scotty-codex-scripted \
 && bun build --compile container/scripted/claude.ts --outfile /out/scotty-claude-scripted

FROM node:22-bookworm-slim
# supervisorVersion in protocol/supervisor.ts; a custom image built FROM this one must keep it.
LABEL scotty.supervisor="1"
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates procps curl sudo unzip xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.157.1 \
       @anthropic-ai/claude-agent-sdk-linux-x64@0.3.284 \
    && useradd --create-home --home-dir /home/scotty scotty \
    && echo "scotty ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/scotty && chmod 0440 /etc/sudoers.d/scotty \
    && mkdir /workspace && chown scotty:scotty /workspace
# The e2e fixture repository (fixtureRepo in protocol/supervisor.ts): one README on main. It is
# owned by scotty because git won't serve a repository owned by another user.
# Pushes to it skip the Worker's refs/heads/scotty/* check; it lives only as long as the container.
RUN git init -q --bare -b main /opt/scotty/fixture.git && mkdir /tmp/fixture \
    && git -C /tmp/fixture init -q -b main && echo "Scotty e2e fixture" > /tmp/fixture/README \
    && git -C /tmp/fixture add README \
    && git -C /tmp/fixture -c user.name=scotty -c user.email=scotty@localhost commit -q -m fixture \
    && git -C /tmp/fixture push -q /opt/scotty/fixture.git main && rm -rf /tmp/fixture \
    && chown -R scotty:scotty /opt/scotty/fixture.git
COPY container/AGENTS.md /etc/scotty/AGENTS.md
COPY --chmod=755 container/scotty-attach /usr/local/bin/scotty-attach
# Each agent reads its global instructions from its own path; all point at one file.
RUN mkdir -m 700 /home/scotty/.codex && ln -s /etc/scotty/AGENTS.md /home/scotty/.codex/AGENTS.md \
    && mkdir -m 700 /home/scotty/.claude && ln -s /etc/scotty/AGENTS.md /home/scotty/.claude/CLAUDE.md \
    && chown -R scotty:scotty /home/scotty/.codex /home/scotty/.claude
COPY --from=build /out/scotty-sup /usr/local/bin/scotty-sup
# The stand-ins for Codex and Claude that e2e sessions run (container/scripted/).
COPY --from=build /out/scotty-codex-scripted /out/scotty-claude-scripted /usr/local/bin/
USER scotty
WORKDIR /workspace
EXPOSE 7000
ENTRYPOINT ["/usr/local/bin/scotty-sup"]
