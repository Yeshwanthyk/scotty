import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

// A full-screen <dialog> that steps through a list: arrow keys and buttons, a horizontal swipe on
// a phone, and Escape, the close button or the phone's Back to leave. It pushes a history entry
// while open, so Back closes it instead of leaving the session; every close goes through that
// entry, and `onClose` runs once it is gone.
const isViewerEntry = (state: unknown) =>
  typeof state === "object" && state !== null && "viewer" in state && state.viewer === true;

export function Viewer({
  label,
  index,
  count,
  onIndex,
  onClose,
  title,
  actions,
  swipeDown = false,
  className,
  children,
}: {
  label: string;
  index: number;
  count: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  title: ReactNode;
  actions?: ReactNode;
  // A downward swipe closes it too (an image; not a diff, which scrolls).
  swipeDown?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const done = useRef(onClose);
  done.current = onClose;
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    element.showModal();
    // showModal focuses the first control; Close is the one to start on.
    closeButton.current?.focus();
    // One entry, even when the effect is set up twice.
    if (!isViewerEntry(history.state)) history.pushState({ ...history.state, viewer: true }, "");
    // Closed before `onClose`, so the page is no longer inert and can take focus back.
    const onPop = () => {
      element.close();
      done.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      element.close();
    };
  }, []);
  const close = () => history.back();
  const step = (by: number) => {
    const next = index + by;
    if (next >= 0 && next < count) onIndex(next);
  };
  const touch = useRef<{ x: number; y: number; many: boolean; ignore: boolean }>(undefined);
  return (
    <dialog
      ref={dialog}
      className={className ? `viewer ${className}` : "viewer"}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") step(1);
        else if (event.key === "ArrowLeft") step(-1);
      }}
      onClick={(event) => {
        // A tap on the backdrop around the content; the content marks taps it keeps.
        if (
          !event.defaultPrevented &&
          event.target instanceof Element &&
          event.target.closest("[data-scrim]") !== null
        )
          close();
      }}
      onTouchStart={(event) => {
        const first = event.touches[0];
        // A zoomed page pans, and a diff that scrolls sideways keeps its scroll.
        const zoomed = (window.visualViewport?.scale ?? 1) > 1.01;
        const scrolls =
          event.target instanceof Element &&
          event.target.closest('.diff-lines[data-wrap="false"]') !== null;
        touch.current =
          first === undefined
            ? undefined
            : {
                x: first.clientX,
                y: first.clientY,
                many: event.touches.length > 1,
                ignore: zoomed || scrolls,
              };
      }}
      onTouchMove={(event) => {
        if (touch.current && event.touches.length > 1) touch.current.many = true;
      }}
      onTouchEnd={(event) => {
        const start = touch.current;
        const end = event.changedTouches[0];
        if (event.touches.length > 0) return;
        touch.current = undefined;
        if (start === undefined || end === undefined || start.many || start.ignore) return;
        const dx = end.clientX - start.x;
        const dy = end.clientY - start.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
        else if (swipeDown && dy > 80 && dy > Math.abs(dx) * 1.5) close();
      }}
    >
      <div className="viewer-bar">
        <div className="viewer-title">{title}</div>
        {count > 1 ? (
          <span className="viewer-count tabular">
            {index + 1} of {count}
          </span>
        ) : null}
        {actions}
        <button
          type="button"
          className="viewer-button pressable"
          aria-label="Close"
          onClick={close}
          ref={closeButton}
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="viewer-body">{children}</div>
      {count > 1 ? (
        <>
          <button
            type="button"
            className="viewer-button viewer-step pressable"
            data-side="prev"
            aria-label="Previous"
            disabled={index === 0}
            onClick={() => step(-1)}
          >
            <Icon name="chevronLeft" />
          </button>
          <button
            type="button"
            className="viewer-button viewer-step pressable"
            data-side="next"
            aria-label="Next"
            disabled={index === count - 1}
            onClick={() => step(1)}
          >
            <Icon name="chevronRight" />
          </button>
        </>
      ) : null}
    </dialog>
  );
}
