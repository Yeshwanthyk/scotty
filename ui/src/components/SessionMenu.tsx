import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

/** Uses the existing lifecycle controls; this component owns disclosure only. */
export function SessionMenu({ children }: { readonly children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <details
      ref={menu}
      className="session-menu"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary ref={trigger} aria-label="Session details and actions">
        <MoreHorizontal aria-hidden size={18} />
      </summary>
      <div className="session-menu-panel">{children}</div>
    </details>
  );
}
