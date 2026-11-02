import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

// One line each. An item with `checked` is a choice of several and keeps a column for its check.
export type MenuItem = {
  label: string;
  onSelect: () => void;
  tone?: "danger";
  checked?: boolean;
  // The menu stays open after the pick, so the item's label can say what happened.
  stay?: boolean;
};

// A small popover of actions behind one "more" button; closes on pick, Escape or an outside press.
// Danger items sit last, under a hairline. It opens below the button and lines up with its right edge unless `side` or `align` says otherwise.
export function Menu({
  label,
  items,
  disabled = false,
  className = "icon-button",
  side = "bottom",
  align = "end",
  children,
}: {
  label: string;
  items: ReadonlyArray<MenuItem>;
  disabled?: boolean;
  className?: string;
  side?: "top" | "bottom";
  align?: "start" | "end";
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (items.length === 0) return null;
  const safe = items.filter((item) => item.tone !== "danger");
  const danger = items.filter((item) => item.tone === "danger");
  const row = (item: MenuItem) => (
    <button
      key={item.label}
      type="button"
      role={item.checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={item.checked}
      className="menu-item"
      data-tone={item.tone}
      onClick={() => {
        if (!item.stay) setOpen(false);
        item.onSelect();
      }}
    >
      {item.checked === undefined ? null : <Icon name="check" size={14} />}
      <span className="menu-text">{item.label}</span>
    </button>
  );
  return (
    <div className="menu" ref={root}>
      <button
        type="button"
        className={`${className} pressable`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {children ?? <Icon name="more" />}
      </button>
      {open ? (
        <div className="menu-list" role="menu" data-side={side} data-align={align}>
          {safe.map(row)}
          {safe.length > 0 && danger.length > 0 ? (
            <div className="menu-separator" role="separator" />
          ) : null}
          {danger.map(row)}
        </div>
      ) : null}
    </div>
  );
}
