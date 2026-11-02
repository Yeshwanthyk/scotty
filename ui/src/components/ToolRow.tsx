import { createContext, useContext, useState } from "react";
import { changeDiff } from "../data/diff";
import type { Tool } from "../protocol/session/conversation";
import { DiffLines, DiffStat } from "./DiffLines";
import { Icon, Spinner } from "./Icon";

// Summaries start with an imperative verb; rows read it in the tense of the tool's status.
const tenses: Record<string, [string, string]> = {
  Read: ["Reading", "Read"],
  Search: ["Searching", "Searched"],
  List: ["Listing", "Listed"],
  Explore: ["Exploring", "Explored"],
  View: ["Viewing", "Viewed"],
  Edit: ["Editing", "Edited"],
  Create: ["Creating", "Created"],
  Delete: ["Deleting", "Deleted"],
  Write: ["Writing", "Wrote"],
  Open: ["Opening", "Opened"],
  Start: ["Starting", "Started"],
  Message: ["Messaging", "Messaged"],
  Wait: ["Waiting", "Waited"],
  Update: ["Updating", "Updated"],
  Run: ["Running", "Ran"],
};

// The tools each subagent call ran, by the call's id; a turn provides them for its rows.
export const SubagentTools = createContext<ReadonlyMap<string, ReadonlyArray<Tool>>>(new Map());

export function phrase(tool: Tool): { verb: string; target: string; mono: boolean } {
  const running = tool.status === "running";
  // Claude's subagent calls are summarised by their own description, which has no tense to change.
  if (tool.name === "Agent" || tool.name === "Task")
    return { verb: tool.summary, target: "", mono: false };
  if (tool.category === "run" || tool.category === "check")
    return {
      verb: running ? "Running" : "Ran",
      target: tool.summary,
      mono: true,
    };
  if (tool.category === "research" && tool.summary.includes(" · "))
    return {
      verb: running ? "Calling" : "Called",
      target: tool.summary,
      mono: false,
    };
  const [first = "", ...rest] = tool.summary.split(" ");
  const tense = tenses[first];
  if (tense === undefined) return { verb: tool.summary, target: "", mono: false };
  // File names and paths read in mono; searches and subagent verbs read as prose.
  const prose = ["Search", "Wait", "Start", "Message"].includes(first);
  return { verb: tense[running ? 0 : 1], target: rest.join(" "), mono: !prose };
}

// Each step is marked by a dot; a running one spins in its place.
function Marker({ running }: { running: boolean }) {
  return (
    <span className="tool-mark">{running ? <Spinner size={12} /> : <span className="dot" />}</span>
  );
}

function Trail({ tool }: { tool: Tool }) {
  if (tool.status === "running") return null;
  const added = tool.changes.reduce((sum, change) => sum + changeDiff(change).added, 0);
  const removed = tool.changes.reduce((sum, change) => sum + changeDiff(change).removed, 0);
  return (
    <>
      {tool.category === "change" ? <DiffStat added={added} removed={removed} /> : null}
      {tool.exitCode !== null && tool.exitCode !== 0 ? (
        <span className="tabular exit">exit {tool.exitCode}</span>
      ) : null}
      {tool.status === "declined" ? <span>Declined</span> : null}
    </>
  );
}

const hasBody = (tool: Tool) => tool.changes.length > 0 || tool.output !== "" || tool.input !== "";

export function ToolRow({ tool }: { tool: Tool }) {
  const [open, setOpen] = useState(false);
  const { verb, target, mono } = phrase(tool);
  const children = useContext(SubagentTools).get(tool.id) ?? [];
  const expandable = hasBody(tool) || children.length > 0;
  // A running subagent shows the step it is on; an opened one shows every step, then its report.
  const current = tool.status === "running" && !open ? children.at(-1) : undefined;
  return (
    <div
      className="tool"
      data-status={tool.status}
      data-failed={tool.status === "failed" || (tool.exitCode !== null && tool.exitCode !== 0)}
    >
      <button
        type="button"
        className="tool-row"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        title={tool.input || tool.summary}
      >
        <Marker running={tool.status === "running"} />
        <span className="verb">{verb}</span>
        {target ? <span className={mono ? "target mono" : "target"}>{target}</span> : null}
        <span className="trail">
          {children.length > 0 ? (
            <span className="tabular">
              {children.length} {children.length === 1 ? "step" : "steps"}
            </span>
          ) : null}
          <Trail tool={tool} />
          {expandable ? <Icon name="chevronRight" size={12} className="chevron" /> : null}
        </span>
      </button>
      {current !== undefined ? (
        <div className="group-children" data-current>
          <ToolRow key={current.id} tool={current} />
        </div>
      ) : null}
      {open && children.length > 0 ? (
        <div className="group-children">
          {children.map((child) => (
            <ToolRow key={child.id} tool={child} />
          ))}
        </div>
      ) : null}
      {open && hasBody(tool) ? <ToolBody tool={tool} /> : null}
    </div>
  );
}

function ToolBody({ tool }: { tool: Tool }) {
  if (tool.changes.length > 0)
    return (
      <div className="tool-body">
        {tool.changes.map((change) => {
          const file = changeDiff(change);
          return (
            <div key={change.path}>
              {tool.changes.length > 1 ? (
                <div className="diff-file-head mono" style={{ position: "static" }}>
                  {change.path}
                </div>
              ) : null}
              <DiffLines file={file} limit={120} />
            </div>
          );
        })}
      </div>
    );
  const command = tool.category === "run" || tool.category === "check";
  const output = tool.output.replace(/^\n+/, "");
  // Output reads on a thin rule under its row, the command first, as a terminal shows it.
  return (
    <div className="tool-output">
      {tool.input ? (
        <pre className="tool-input" data-prompt={command}>
          {tool.input}
        </pre>
      ) : null}
      {output ? <Output text={output} /> : null}
    </div>
  );
}

const shownLines = 40;

function Output({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  const cut = !all && lines.length > shownLines + 2;
  return (
    <>
      <pre>{cut ? lines.slice(0, shownLines).join("\n") : text}</pre>
      {lines.length > shownLines + 2 ? (
        <button type="button" className="tool-more" onClick={() => setAll((value) => !value)}>
          {all ? "Show less" : `Show ${lines.length - shownLines} more lines`}
        </button>
      ) : null}
    </>
  );
}

// Consecutive reads, searches and listings read as one line: "Explored 4 files, 2 searches".
export function ExploreGroup({ tools }: { tools: Tool[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.some((tool) => tool.status === "running");
  const reads = tools.filter(
    (tool) => tool.summary.startsWith("Read") || tool.summary.startsWith("View"),
  ).length;
  const searches = tools.filter((tool) => tool.summary.startsWith("Search")).length;
  const other = tools.length - reads - searches;
  const parts = [
    reads > 0 ? `${reads} ${reads === 1 ? "file" : "files"}` : "",
    searches > 0 ? `${searches} ${searches === 1 ? "search" : "searches"}` : "",
    other > 0 ? `${other} ${other === 1 ? "listing" : "listings"}` : "",
  ].filter(Boolean);
  return (
    <div className="tool group-row">
      <button
        type="button"
        className="tool-row"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Marker running={running} />
        <span className="verb">{running ? "Exploring" : "Explored"}</span>
        <span className="target">{parts.join(", ")}</span>
        <span className="trail">
          <Icon name="chevronRight" size={12} className="chevron" />
        </span>
      </button>
      {open ? (
        <div className="group-children">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
