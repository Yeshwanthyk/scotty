import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import * as stylex from "@stylexjs/stylex";
import { TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { colors, spacing } from "../theme/tokens.stylex";

const styles = stylex.create({
  icon: { width: "13px", height: "13px", strokeWidth: 1.8 },
  view: {
    height: "100%",
    minHeight: 0,
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    backgroundColor: "#07090a",
  },
  status: {
    minHeight: "32px",
    paddingInline: spacing.md,
    display: "flex",
    alignItems: "center",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
  },
  title: {
    display: "inline-flex",
    alignItems: "center",
    gap: spacing.sm,
    color: colors.quiet,
    fontSize: "11px",
  },
  surface: { minHeight: 0, padding: "8px 10px", overflow: "hidden" },
});

export default function Terminal({ sessionId }: { readonly sessionId: string }) {
  const surface = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("Connecting");
  useEffect(() => {
    const host = surface.current;
    if (host === null) return;
    const terminal = new XtermTerminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.18,
      scrollback: 10_000,
      theme: {
        background: "#07090a",
        foreground: "#eee7d3",
        cursor: "#dab77e",
        selectionBackground: "#29424d",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    const url = new URL(`/s/${encodeURIComponent(sessionId)}/terminal`, window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("cols", String(terminal.cols));
    url.searchParams.set("rows", String(terminal.rows));
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data));
        return;
      }
      if (typeof event.data !== "string") return;
      try {
        const message: unknown = JSON.parse(event.data);
        if (
          message !== null &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "ready"
        ) {
          setStatus("Connected");
          terminal.focus();
        }
      } catch {
        terminal.write(event.data);
      }
    });
    socket.addEventListener("close", () => setStatus("Disconnected"));
    socket.addEventListener("error", () => setStatus("Connection error"));
    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data));
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    });
    resize.observe(host);
    return () => {
      resize.disconnect();
      input.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [sessionId]);
  return (
    <div aria-label="Session terminal" {...stylex.props(styles.view)}>
      <div role="status" {...stylex.props(styles.status)}>
        <span {...stylex.props(styles.title)}>
          <TerminalSquare aria-hidden {...stylex.props(styles.icon)} />
          {status}
        </span>
      </div>
      <div ref={surface} {...stylex.props(styles.surface)} />
    </div>
  );
}
