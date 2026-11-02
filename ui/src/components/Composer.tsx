import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Icon } from "./Icon";
import { fitsOneLine, measure, type Metrics } from "./measure";

// Enter sends on a keyboard; on touch Enter is a newline and the button sends.
const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** Enter sends on a keyboard, and Cmd or Ctrl+Enter anywhere; Shift+Enter, or Enter on touch, is a newline. */
const sends = (event: KeyboardEvent) =>
  event.key === "Enter" &&
  !event.nativeEvent.isComposing &&
  (event.metaKey || event.ctrlKey || (!event.shiftKey && !coarse()));

// Where the browser sizes a field to its text, the textarea grows by itself and nothing is measured to size it.
const fieldSizing = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

/** Sizes the textarea to its text where the browser doesn't. */
function grow(element: HTMLElement) {
  if (fieldSizing) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

/** Whether the text wraps, from whether it did: open stays open until the text fits the pill again. */
function wraps(
  value: string,
  open: boolean,
  metrics: Metrics,
  pillWidth: number,
  element: HTMLElement,
): boolean {
  if (value.includes("\n")) return true;
  if (open) return !fitsOneLine(metrics, value, pillWidth);
  // Text that plainly fits the pill cannot have wrapped; only near the edge is the layout asked.
  return !fitsOneLine(metrics, value, pillWidth) && element.scrollHeight > metrics.oneLine;
}

/**
 * Whether the composer shows as a card: always with `card`, else once the text has wrapped. It closes again only
 * when the text would fit the pill's narrower line, measured against the width the pill had, so it never flips back
 * and forth at the edge.
 */
function useOpen(area: RefObject<HTMLTextAreaElement | null>, value: string, card: boolean) {
  const [open, setOpen] = useState(false);
  const pillWidth = useRef(0);
  const metrics = useRef<Metrics | null>(null);
  const showing = open || card;
  const shown = useRef(showing);

  // The pill's width, kept as layout settles rather than read (forcing a layout) on every keystroke.
  useLayoutEffect(() => {
    const element = area.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // A resize may be a new text size, so the style is read again too.
      metrics.current = null;
      if (!shown.current) pillWidth.current = element.clientWidth;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [area]);

  useLayoutEffect(() => {
    const element = area.current;
    if (element === null) return;
    if (shown.current !== showing) {
      shown.current = showing;
      metrics.current = null;
    }
    grow(element);
    if (card) return;
    metrics.current ??= measure(element);
    if (pillWidth.current === 0 && !showing) pillWidth.current = element.clientWidth;
    const next = wraps(value, open, metrics.current, pillWidth.current, element);
    if (next !== open) setOpen(next);
  }, [area, value, open, showing, card]);

  return showing;
}

/**
 * A pill while its text is one line, a card once the text wraps (or always, with `card`). The text, then the
 * host's `children`, then one round action: Send, or Stop, ringed, while a turn runs and nothing is typed.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  placeholder,
  disabled = false,
  busy = false,
  working = false,
  autoFocus = false,
  card = false,
  children,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Offered in place of Send while a turn runs and nothing is typed. */
  onStop?: () => void;
  placeholder: string;
  disabled?: boolean;
  /** Something must settle first, so Send waits. */
  busy?: boolean;
  /** A turn is running. */
  working?: boolean;
  autoFocus?: boolean;
  /** Always the card, for a button row too wide for the pill. */
  card?: boolean;
  /** More in the button row, before the action. */
  children?: ReactNode;
  /** The text field's accessible name. */
  label: string;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const open = useOpen(area, value, card);
  const empty = value.trim() === "";
  const stop = working && empty && onStop !== undefined;
  return (
    <form
      className="composer"
      data-open={open}
      onSubmit={(event) => {
        event.preventDefault();
        if (stop) onStop();
        else if (!empty && !busy && !disabled) onSubmit();
      }}
    >
      <textarea
        ref={area}
        rows={1}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (!sends(event)) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="composer-bar">
        {children}
        {stop ? (
          <StopButton disabled={disabled || busy} />
        ) : (
          <SendButton disabled={disabled || busy || empty} />
        )}
      </div>
    </form>
  );
}

function SendButton({ disabled }: { disabled: boolean }) {
  return (
    <button
      type="submit"
      className="send-button pressable"
      data-mode="send"
      aria-label="Send"
      disabled={disabled}
    >
      <Icon name="arrowUp" size={15} />
    </button>
  );
}

/** Stop: the ink square on a raised circle, a thin arc turning round it while the turn runs. */
function StopButton({ disabled }: { disabled: boolean }) {
  return (
    <button
      type="submit"
      className="send-button pressable"
      data-mode="stop"
      aria-label="Stop"
      disabled={disabled}
    >
      <svg className="send-ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r="16.5" />
      </svg>
      <Icon name="stop" size={11} />
    </button>
  );
}

export function AgentChip({ kind }: { kind: string }) {
  return (
    <span className="agent">
      <Icon name="terminal" size={14} />
      {kind === "codex" ? "Codex" : kind === "claude" ? "Claude" : kind === "pi" ? "Pi" : kind}
    </span>
  );
}
