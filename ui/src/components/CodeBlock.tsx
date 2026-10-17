import { useId, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

// Code, commands and their output, after shadcn's Code Block: a header with a title and actions,
// optional line numbers and wrapping, diff lines, and a small size for tool output. Line numbers
// and diff markers come from CSS, so a selection copies only the code.

type Line = "default" | "added" | "removed" | "hunk";

// A unified diff reads as added and removed lines; anything else is plain.
const lineKind = (line: string, diff: boolean): Line =>
  !diff || line.startsWith("+++") || line.startsWith("---")
    ? "default"
    : line.startsWith("@@")
      ? "hunk"
      : line.startsWith("+")
        ? "added"
        : line.startsWith("-")
          ? "removed"
          : "default";

export function CodeBlock({
  code,
  title,
  icon,
  size = "default",
  tone = "default",
  lineNumbers = false,
  wrap: initialWrap = false,
  diff = false,
  collapseAfter,
  prompt = false,
  trailing,
}: {
  code: string;
  title?: ReactNode;
  icon?: Parameters<typeof Icon>[0]["name"];
  size?: "default" | "sm";
  tone?: "default" | "destructive";
  lineNumbers?: boolean;
  wrap?: boolean;
  diff?: boolean;
  // Lines shown before "Show N more lines"; unset shows everything.
  collapseAfter?: number;
  // The code is a command: it reads after a `$` and in full ink.
  prompt?: boolean;
  // A short note at the end of the header, such as an exit code.
  trailing?: string;
}) {
  const id = useId();
  const [wrap, setWrap] = useState(initialWrap);
  const [expanded, setExpanded] = useState(false);
  const lines = code.replace(/\n+$/, "").split("\n");
  const cap = collapseAfter !== undefined && lines.length > collapseAfter + 2 ? collapseAfter : 0;
  const shown = cap > 0 && !expanded ? lines.slice(0, cap) : lines;
  return (
    <figure className="code-block" data-size={size} data-tone={tone}>
      {title !== undefined ? (
        <figcaption className="code-block-head">
          <span className="code-block-title">
            {icon ? <Icon name={icon} size={13} /> : null}
            <span>{title}</span>
          </span>
          {trailing ? <span className="code-block-trailing tabular">{trailing}</span> : null}
          <span className="code-block-actions">
            <button
              type="button"
              className="icon-button pressable"
              aria-label="Wrap lines"
              aria-pressed={wrap}
              onClick={() => setWrap((value) => !value)}
            >
              <Icon name="wrap" size={13} />
            </button>
            <CopyButton value={code} />
          </span>
        </figcaption>
      ) : (
        <span className="code-block-actions" data-floating>
          <CopyButton value={code} />
        </span>
      )}
      <pre
        id={id}
        className="code-block-content"
        data-scrollbar="quiet"
        data-wrap={wrap}
        data-numbers={lineNumbers}
        data-prompt={prompt}
        dir="ltr"
        tabIndex={0}
      >
        <code>
          {shown.map((line, index) => (
            <span key={index} className="code-line" data-kind={lineKind(line, diff)}>
              {line === "" ? "\n" : `${line}\n`}
            </span>
          ))}
        </code>
      </pre>
      {cap > 0 ? (
        <button
          type="button"
          className="code-block-more pressable"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name="chevronDown" size={12} className="chevron" />
          {expanded ? "Show less" : `Show ${lines.length - cap} more lines`}
        </button>
      ) : null}
    </figure>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <button
        type="button"
        className="icon-button pressable"
        aria-label="Copy"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
        }
      >
        <Icon name={copied ? "check" : "copy"} size={13} />
      </button>
      <span className="sr-only" role="status">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}
