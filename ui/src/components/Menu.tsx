import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type MenuItem = {
  label: string;
  icon: IconName;
  onSelect: () => void;
  tone?: "danger";
  detail?: string;
};

// A small popover of actions behind one "more" button; closes on pick, Escape or an outside press.
export function Menu({
  label,
  items,
  disabled = false,
  children,
}: {
  label: string;
  items: ReadonlyArray<MenuItem>;
  disabled?: boolean;
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
  return (
    <div className="menu" ref={root}>
      <button
        type="button"
        className="icon-button pressable"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {children ?? <Icon name="more" />}
      </button>
      {open ? (
        <div className="menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="menu-item"
              data-tone={item.tone}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <Icon name={item.icon} size={14} />
              <span className="menu-text">
                <span>{item.label}</span>
                {item.detail ? <span className="menu-detail">{item.detail}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
