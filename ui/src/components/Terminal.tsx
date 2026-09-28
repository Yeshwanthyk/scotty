import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

type Status = "Connecting" | "Connected" | "Closed";

// Colors follow the page tokens, so the terminal switches with the system theme.
const theme = (): ITheme => {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: token("--sunken"),
    foreground: token("--ink"),
    cursor: token("--ink"),
    cursorAccent: token("--sunken"),
    selectionBackground: token("--selected"),
    scrollbarSliderBackground: token("--line"),
    scrollbarSliderHoverBackground: token("--line-strong"),
    scrollbarSliderActiveBackground: token("--line-hover"),
  };
};

export default function Terminal({ sessionId }: { sessionId: string }) {
  const surface = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>("Connecting");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const host = surface.current;
    if (host === null) return;
    setStatus("Connecting");
    const terminal = new Xterm({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
      fontSize: 12.5,
      scrollback: 5000,
      theme: theme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => (terminal.options.theme = theme());
    scheme.addEventListener("change", retheme);

    const url = new URL(`/api/sessions/${encodeURIComponent(sessionId)}/terminal`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("cols", String(terminal.cols));
    url.searchParams.set("rows", String(terminal.rows));
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const encoder = new TextEncoder();
    socket.addEventListener("open", () => {
      setStatus("Connected");
      terminal.focus();
    });
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
    });
    socket.addEventListener("close", () => setStatus("Closed"));
    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    });
    resize.observe(host);
    return () => {
      resize.disconnect();
      scheme.removeEventListener("change", retheme);
      input.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [sessionId, attempt]);
  return (
    <div className="terminal">
      <div className="terminal-bar" role="status">
        <span className="terminal-dot" data-status={status} />
        {status === "Closed" ? "Shell closed" : status}
        {status === "Closed" ? (
          <button
            type="button"
            className="button pressable"
            style={{ marginLeft: "auto" }}
            onClick={() => setAttempt((n) => n + 1)}
          >
            New shell
          </button>
        ) : null}
      </div>
      <div ref={surface} className="terminal-surface" />
    </div>
  );
}
