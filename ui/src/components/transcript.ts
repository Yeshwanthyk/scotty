import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

// The thread's scroll, after shadcn's Message Scroller: the view moves only when the reader asked
// it to. A new turn starts near the top with a peek of the one before, and its reply grows into
// the room below; once the reply fills the view, the view follows it. Wheel, touch, scroll keys,
// the scrollbar or a text selection hand the view back to the reader, and reaching the end again
// resumes following. Turns shown above keep the reader's place. A spacer after the last turn
// makes room to anchor a turn that is shorter than the view.
//
// The state lives in refs so scrolling never re-renders the thread; only `atEnd` is React state.

type Mode = "following" | "anchored" | "free";

// How much of the previous turn stays visible above an anchored one.
const peek = 64;
// Within this distance of the end counts as at the end.
const edge = 24;
const scrollKeys = new Set(["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "]);

export function useTranscript(lastTurn: string | undefined) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const mode = useRef<Mode>("following");
  const anchor = useRef<Element | null>(null);
  const spacerHeight = useRef(0);
  // The first visible row and its offset in the view, to restore after rows appear above it.
  const place = useRef<{ row: Element; top: number } | null>(null);
  const opened = useRef<string | undefined>(undefined);
  const expecting = useRef(false);
  const [atEnd, setAtEnd] = useState(true);

  const rows = () => {
    const element = content.current;
    return element === null
      ? []
      : Array.from(element.children).filter((row) => row !== spacer.current);
  };
  // Where the content ends without the spacer, in the viewport's scroll coordinates.
  const naturalEnd = () => {
    const view = viewport.current;
    const element = content.current;
    if (view === null || element === null) return 0;
    const top = view.getBoundingClientRect().top - view.scrollTop;
    const padding = parseFloat(getComputedStyle(element).paddingBottom) || 0;
    let end = 0;
    for (const row of rows()) end = Math.max(end, row.getBoundingClientRect().bottom - top);
    return end + padding;
  };
  const offsetOf = (row: Element) => {
    const view = viewport.current;
    return view === null
      ? 0
      : row.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
  };
  const setSpacer = (height: number) => {
    const element = spacer.current;
    const next = Math.max(0, Math.ceil(height));
    if (element === null || next === spacerHeight.current) return;
    spacerHeight.current = next;
    element.hidden = next === 0;
    element.style.height = `${next}px`;
    // The content is a flex column with a gap; the spacer takes none of it.
    const gap =
      element.parentElement === null
        ? 0
        : parseFloat(getComputedStyle(element.parentElement).rowGap) || 0;
    element.style.marginTop = next > 0 ? `${-gap}px` : "";
  };
  const remember = () => {
    const view = viewport.current;
    if (view === null) return;
    const top = view.getBoundingClientRect().top;
    const row = rows().find(
      (candidate) =>
        candidate.hasAttribute("data-turn") && candidate.getBoundingClientRect().bottom > top,
    );
    place.current = row === undefined ? null : { row, top: row.getBoundingClientRect().top - top };
  };
  const measure = () => {
    const view = viewport.current;
    if (view === null) return;
    const end = naturalEnd() - view.scrollTop - view.clientHeight <= edge;
    setAtEnd(mode.current === "following" || end);
    return end;
  };
  const toEnd = (behavior: ScrollBehavior = "auto") => {
    const view = viewport.current;
    if (view === null) return;
    setSpacer(0);
    view.scrollTo({ top: view.scrollHeight, behavior });
  };
  // Puts the row near the top, growing the spacer when the content below can't fill the view.
  const anchorTo = (row: Element) => {
    const view = viewport.current;
    if (view === null) return;
    const target = Math.max(0, offsetOf(row) - peek);
    setSpacer(target + view.clientHeight - naturalEnd());
    view.scrollTop = target;
  };

  const settle = useCallback(() => {
    const view = viewport.current;
    if (view === null) return;
    if (mode.current === "following") toEnd();
    else if (mode.current === "anchored" && anchor.current?.isConnected) {
      const before = spacerHeight.current;
      anchorTo(anchor.current);
      // The reply has filled the room under its turn: follow it from here.
      if (before > 0 && spacerHeight.current === 0) {
        mode.current = "following";
        toEnd();
      }
    } else {
      // Rows appeared above the reader: put the row they were reading back where it was.
      const saved = place.current;
      if (saved !== null && saved.row.isConnected) {
        const drift = saved.row.getBoundingClientRect().top - view.getBoundingClientRect().top;
        if (Math.abs(drift - saved.top) > 0.5) view.scrollTop += drift - saved.top;
      }
      // Keep only as much spacer as the current position needs.
      setSpacer(view.scrollTop + view.clientHeight - naturalEnd());
    }
    remember();
    measure();
  }, []);

  // A new turn anchors when the reader sent it or was following; the first turns seen open at the
  // last one, or at the end when it fits.
  useLayoutEffect(() => {
    const view = viewport.current;
    const element = content.current;
    if (lastTurn === undefined || view === null || element === null) return;
    const row = element.querySelector(`[data-turn="${CSS.escape(lastTurn)}"]`);
    if (opened.current === undefined) {
      opened.current = lastTurn;
      if (row !== null && naturalEnd() - offsetOf(row) > view.clientHeight) {
        mode.current = "anchored";
        anchor.current = row;
        anchorTo(row);
      } else {
        mode.current = "following";
        toEnd();
      }
    } else if (opened.current !== lastTurn) {
      opened.current = lastTurn;
      if (row !== null && (expecting.current || mode.current !== "free")) {
        mode.current = "anchored";
        anchor.current = row;
        anchorTo(row);
      }
    }
    expecting.current = false;
    remember();
    measure();
  }, [lastTurn]);

  // Growth (streaming, images, Mermaid, expanded rows), new rows and a resized view all settle.
  useEffect(() => {
    const view = viewport.current;
    const element = content.current;
    if (view === null || element === null) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(settle);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(view);
    resize.observe(element);
    const mutation = new MutationObserver(schedule);
    mutation.observe(element, { childList: true });
    // Selecting text is reading: stop moving.
    const select = () => {
      const selection = document.getSelection();
      if (selection !== null && !selection.isCollapsed && element.contains(selection.anchorNode))
        release();
    };
    document.addEventListener("selectionchange", select);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      document.removeEventListener("selectionchange", select);
    };
  }, [settle]);

  function release() {
    if (mode.current === "free") return;
    mode.current = "free";
    anchor.current = null;
  }

  // Handlers for the viewport element.
  const handlers = {
    onWheel: release,
    onTouchMove: release,
    onKeyDown: (event: KeyboardEvent) => {
      if (scrollKeys.has(event.key) && event.target === event.currentTarget) release();
    },
    // A press on the viewport itself, not its content, is on the scrollbar.
    onPointerDown: (event: PointerEvent) => {
      if (event.target === event.currentTarget) release();
    },
    // Opening or closing something is reading it: the view stays where the reader is.
    onClickCapture: (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("[aria-expanded]") !== null)
        release();
    },
    onScroll: () => {
      remember();
      const end = measure();
      // The reader scrolled back to the end: follow again.
      if (end === true && mode.current === "free") {
        mode.current = "following";
        setSpacer(0);
        setAtEnd(true);
      }
    },
  };

  return {
    viewport,
    content,
    spacer,
    handlers,
    atEnd,
    // Back to the latest output, following it.
    jump: () => {
      mode.current = "following";
      anchor.current = null;
      setAtEnd(true);
      toEnd("smooth");
    },
    // The reader sent a message: anchor the turn it starts even if they had scrolled away.
    expectTurn: () => {
      expecting.current = true;
    },
  };
}
