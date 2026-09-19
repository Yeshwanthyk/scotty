import type { ConversationTurn } from "../domain/conversation";

export const markdownFixture: ReadonlyArray<ConversationTurn> = [
  {
    id: "markdown-preview",
    state: "completed",
    user: "Compare the recent additions for Ziggy, then show how a request flows through the system.",
    tools: [],
    assistant: `## Best recent additions for Ziggy

| Candidate | Added | Useful Ziggy primitive | My take |
| --- | --- | --- | --- |
| **Hermes browser vault** | Sep 10 | Select a credential handle; fill its password locally on the correct website | **Strongest new capability.** Complements computer-use without putting passwords in model context. Requires secure browser transport and interactive setup. |
| **OpenClaw Team Reports** | Sep 7 | Collect bounded activity evidence → generate a report | Reuse Ziggy’s existing automations and delivery. Start as a skill; avoid importing another scheduler. |
| **Hermes decision questionnaire** | Aug 29 | Turn missing stakeholder knowledge into a Markdown handoff | **Quickest addition.** Skill-only, useful immediately. |
| **OpenClaw Session Share** | Sep 12 | Read-only access to selected conversations | Useful for collaboration. Start smaller with selected session export; remote sharing needs access controls. |
| **Hermes dynamic workflow** | Sep 12 | Manifest + intermediate files + repeated research tasks | Useful recipe, but its asynchronous delegation needs adaptation to Ziggy’s agent contracts. |
| **Hermes persistent annotations** | Aug 20 | Highlight the evidence an agent is discussing | Extend existing browser/screenshot tools rather than adding another controller. |

## Request flow

\`\`\`mermaid
flowchart LR
  A[User request] --> B{Needs a credential?}
  B -->|Yes| C[Browser vault]
  B -->|No| D[Run skill]
  C --> D
  D --> E[Review evidence]
\`\`\`

## Handoff sequence

\`\`\`mermaid
sequenceDiagram
  actor User
  participant Agent
  participant Browser
  User->>Agent: Open the workspace
  Agent->>Browser: Run the bounded task
  Browser-->>Agent: Evidence and result
  Agent-->>User: Summary with sources
\`\`\`

## Incomplete diagram

\`\`\`mermaid
flowchart LR
  A[Still streaming
\`\`\`
`,
  },
];
