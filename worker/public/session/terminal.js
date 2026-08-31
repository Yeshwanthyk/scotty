import { FitAddon } from "/vendor/xterm-addon-fit.mjs";
import { Terminal } from "/vendor/xterm.mjs";
import { createTerminalConnection, terminalRestartUrl } from "./terminal-transport.js";

const MIN_DRAWER_HEIGHT = 220;
const DEFAULT_DRAWER_HEIGHT = 360;

export function createTerminalDrawer({
  root,
  surface,
  status,
  statusLabel,
  closeButton,
  restartButton,
  resizer,
  workspace,
  fetch,
  origin,
  onOpenChange,
}) {
  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: '"SFMono-Regular", "Cascadia Mono", Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1.18,
    scrollback: 10_000,
    theme: {
      background: "#02080d",
      foreground: "#eee7d3",
      cursor: "#f08a64",
      cursorAccent: "#02080d",
      selectionBackground: "#29424d",
      black: "#07131a",
      red: "#ff8278",
      green: "#76b58b",
      yellow: "#d4a96e",
      blue: "#7ca4bd",
      magenta: "#b99ab5",
      cyan: "#79afb9",
      white: "#eee7d3",
      brightBlack: "#65747a",
      brightRed: "#ff9d96",
      brightGreen: "#91c5a4",
      brightYellow: "#e2c98d",
      brightBlue: "#91bad1",
      brightMagenta: "#cbaec7",
      brightCyan: "#8dc4ce",
      brightWhite: "#fffaf0",
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(surface);

  let open = false;
  let sessionId;
  let opener;
  let dragPointer;

  const setState = (state, message) => {
    status.dataset.state = state;
    statusLabel.textContent = message;
  };

  const connection = createTerminalConnection({
    WebSocket: window.WebSocket,
    origin,
    dimensions: () => ({ cols: terminal.cols, rows: terminal.rows }),
    onData: (data) => terminal.write(data),
    onState: setState,
    onReady: () => terminal.focus(),
  });
  terminal.onData((data) => connection.send(data));
  terminal.onResize(() => connection.resize());

  const fitAndResize = () => {
    if (!open) return;
    fit.fit();
    connection.resize();
  };

  const applyHeight = (height) => {
    const maximum = Math.max(MIN_DRAWER_HEIGHT, Math.floor(workspace.clientHeight * 0.7));
    const next = Math.min(maximum, Math.max(MIN_DRAWER_HEIGHT, Math.round(height)));
    root.style.setProperty("--terminal-height", `${next}px`);
    resizer.setAttribute("aria-valuenow", String(next));
    fitAndResize();
  };

  const close = () => {
    if (!open) return;
    open = false;
    connection.disconnect();
    root.dataset.open = "false";
    root.setAttribute("aria-hidden", "true");
    root.inert = true;
    onOpenChange(false);
    opener?.focus({ preventScroll: true });
    opener = undefined;
  };

  const show = (nextSessionId, nextOpener) => {
    if (!nextSessionId) return;
    sessionId = nextSessionId;
    opener = nextOpener;
    open = true;
    root.dataset.open = "true";
    root.setAttribute("aria-hidden", "false");
    root.inert = false;
    onOpenChange(true);
    if (!root.style.getPropertyValue("--terminal-height")) applyHeight(DEFAULT_DRAWER_HEIGHT);
    requestAnimationFrame(() => {
      fitAndResize();
      connection.connect(sessionId);
      terminal.focus();
    });
  };

  const restart = async () => {
    if (!sessionId || restartButton.disabled) return;
    const restartingSessionId = sessionId;
    restartButton.disabled = true;
    connection.disconnect();
    setState("restarting", "Restarting");
    try {
      const response = await fetch(terminalRestartUrl(restartingSessionId), {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        throw new Error(body?.error?.message ?? `Terminal restart failed (${response.status})`);
      }
      if (!open || sessionId !== restartingSessionId) return;
      terminal.reset();
      connection.reconnect();
    } catch (error) {
      if (open && sessionId === restartingSessionId)
        setState(
          "unavailable",
          error instanceof Error ? error.message : "The terminal could not restart",
        );
    } finally {
      restartButton.disabled = false;
    }
  };

  const beginResize = (event) => {
    if (matchMedia("(max-width: 760px)").matches) return;
    dragPointer = event.pointerId;
    resizer.setPointerCapture(event.pointerId);
    document.body.classList.add("terminal-resizing");
  };
  const moveResize = (event) => {
    if (dragPointer !== event.pointerId) return;
    const bounds = workspace.getBoundingClientRect();
    applyHeight(bounds.bottom - event.clientY);
  };
  const endResize = (event) => {
    if (dragPointer !== event.pointerId) return;
    dragPointer = undefined;
    document.body.classList.remove("terminal-resizing");
    if (resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
  };

  closeButton.addEventListener("click", close);
  restartButton.addEventListener("click", () => void restart());
  resizer.addEventListener("pointerdown", beginResize);
  resizer.addEventListener("pointermove", moveResize);
  resizer.addEventListener("pointerup", endResize);
  resizer.addEventListener("pointercancel", endResize);
  resizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const current = Number.parseInt(resizer.getAttribute("aria-valuenow") ?? "", 10);
    applyHeight(
      (Number.isFinite(current) ? current : DEFAULT_DRAWER_HEIGHT) +
        (event.key === "ArrowUp" ? 24 : -24),
    );
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab" || !matchMedia("(max-width: 760px)").matches) return;
    const controls = [
      ...root.querySelectorAll(
        'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });

  const observer = new ResizeObserver(fitAndResize);
  observer.observe(workspace);

  root.dataset.open = "false";
  root.setAttribute("aria-hidden", "true");
  root.inert = true;
  setState("closed", "Closed");

  return {
    open: show,
    close,
    setSessionId(nextSessionId) {
      if (sessionId === nextSessionId) return;
      sessionId = nextSessionId;
      terminal.reset();
      if (open && sessionId) connection.connect(sessionId);
      else connection.disconnect();
    },
    dispose() {
      observer.disconnect();
      connection.dispose();
      terminal.dispose();
    },
  };
}
