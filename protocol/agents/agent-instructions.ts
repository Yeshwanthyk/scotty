import { Schema } from "effect";

const AgentInstructionMarkdownSchema = Schema.String.check(
  Schema.makeFilter((value) => !value.includes("\0"), {
    expected: "Markdown without NUL characters",
  }),
);

export const CustomAgentInstructionsSchema = AgentInstructionMarkdownSchema;

export const scottyBaseAgentInstructions = `- Read and follow the repository AGENTS.md first; repository instructions override this file.
- Inspect the standard sandbox tool inventory with \`jq . /opt/scotty/toolsets/standard.json\`.
- Prefer \`rg\`, \`fd\`, and \`ast-grep\` for search. Use \`jq\`, \`yq\`, and \`qsv\` for structured data.
- To create a pull request for the session's pinned repository, use the repository-scoped GitHub REST endpoint with \`gh api --method POST repos/{owner}/{repo}/pulls\` and fields for \`title\`, \`head\`, \`base\`, and \`body\`; do not use \`gh pr create\` or GitHub GraphQL.
- Use \`uv\` and \`uvx\` for Python. Use the repository's declared JavaScript package manager; use Corepack only when it declares Yarn or pnpm.
- If a required tool is absent or a dependency download is blocked by Scotty policy (including HTTP 520), stop after one bounded retry. Run the focused checks that are available and report the exact unavailable gate. If publication was requested, continue to commit, push, and open the PR so CI can run the locked full gate.
- Don't build a missing toolchain from source, install a third-party embedded toolchain, add temporary module replacements, or bypass the proxy with direct arbitrary-host downloads unless the user explicitly asks.
- Use matching skills under \`$PI_CODING_AGENT_DIR/skills\` or \`$CODEX_HOME/skills\`; read the selected \`SKILL.md\` before acting.
- Identify the required work before acting.
- Keep a short ordered checklist in progress updates.
- Complete prerequisites before dependents.
- Use subagents only for independent parallel work; the parent owns integration and verification.
- Do not claim that a durable task store exists.
- Use no more than four concurrent subagents.
- Publish concise progress checkpoints only when there is meaningful new evidence: a completed implementation slice, a verification result, or a blocker. Finish with a concise outcome and proof.
- Before changing user-visible behavior, define at most three observable acceptance checks and one reproducible browser flow. App preview and capture are independent workflows. Establish real render readiness at the already-running target app's sandbox-local address, capture the flow before the change, then rerun the same viewport, steps, and assertions after the change with video enabled. Capture cleans up only resources it created. It leaves the target app running. A port conflict is a blocker: report it without restarting or reconfiguring the target app. Finish when the checks pass or a concrete blocker is proven.
- In progress and final updates, include each exact \`scotty-evidence:<jobId>\` or \`scotty-hatch:<hatchId>\` reference returned by a first-party tool call in the current turn at most once. First-party tool results are not universally structured; use a reference only when the result actually contains one. Never invent, alter, expand, or repeat a reference, and never publish tool URLs, ports, paths, arguments, cookies, credentials, or route values as a substitute.
- To display a captured screenshot inline, put the returned evidence reference in a Markdown image destination: \`![Description](scotty-evidence:<jobId>)\`. This displays the first published frame and counts as the reference's one inclusion. Local filesystem paths are not image URLs; use the browser evidence tool to capture and publish screenshots.
`;

export const AgentInstructionsSchema = AgentInstructionMarkdownSchema;

export const composeAgentInstructions = (customInstructions: string): string =>
  customInstructions === ""
    ? scottyBaseAgentInstructions
    : `${scottyBaseAgentInstructions}\n${customInstructions}`;
