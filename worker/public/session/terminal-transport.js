const MAX_RECONNECT_DELAY_MS = 15_000;

export function terminalSocketUrl(sessionId, origin, dimensions = {}) {
  const url = new URL(`/s/${encodeURIComponent(sessionId)}/terminal`, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (Number.isSafeInteger(dimensions.cols)) url.searchParams.set("cols", String(dimensions.cols));
  if (Number.isSafeInteger(dimensions.rows)) url.searchParams.set("rows", String(dimensions.rows));
  return url;
}

export function terminalRestartUrl(sessionId) {
  return `/s/${encodeURIComponent(sessionId)}/terminal/restart`;
}

export function createTerminalConnection({
  WebSocket,
  origin,
  schedule = window.setTimeout.bind(window),
  cancel = window.clearTimeout.bind(window),
  dimensions,
  onData,
  onState,
  onReady,
}) {
  let activeSessionId;
  let socket;
  let reconnectTimer;
  let reconnectAttempt = 0;
  let desired = false;

  const clearReconnect = () => {
    if (reconnectTimer === undefined) return;
    cancel(reconnectTimer);
    reconnectTimer = undefined;
  };

  const closeSocket = () => {
    const current = socket;
    socket = undefined;
    if (current && current.readyState < WebSocket.CLOSING) current.close();
  };

  const sendResize = () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const size = dimensions();
    socket.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
  };

  const scheduleReconnect = (connect) => {
    if (!desired || reconnectTimer !== undefined) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(reconnectAttempt, 5));
    reconnectAttempt += 1;
    onState("reconnecting", `Reconnecting in ${Math.ceil(delay / 1_000)}s`);
    reconnectTimer = schedule(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const connect = () => {
    if (!desired || !activeSessionId) return;
    clearReconnect();
    closeSocket();
    onState("connecting", reconnectAttempt > 0 ? "Reconnecting" : "Connecting");
    const next = new WebSocket(terminalSocketUrl(activeSessionId, origin, dimensions()));
    next.binaryType = "arraybuffer";
    socket = next;
    next.addEventListener("message", (event) => {
      if (socket !== next) return;
      if (event.data instanceof ArrayBuffer) {
        onData(new Uint8Array(event.data));
        return;
      }
      if (typeof event.data !== "string") return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message?.type === "ready") {
        reconnectAttempt = 0;
        onState("connected", "Connected");
        sendResize();
        onReady();
      } else if (message?.type === "error") {
        onState("unavailable", message.message || "The terminal reported an error");
      } else if (message?.type === "exit") {
        desired = false;
        onState("exited", `Exited with code ${message.code ?? "unknown"}`);
        closeSocket();
      }
    });
    next.addEventListener("close", () => {
      if (socket !== next) return;
      socket = undefined;
      if (!desired) return;
      onState("disconnected", "Disconnected");
      scheduleReconnect(connect);
    });
    next.addEventListener("error", () => {
      if (socket === next) onState("disconnected", "Connection error");
    });
  };

  return {
    connect(sessionId) {
      activeSessionId = sessionId;
      desired = true;
      reconnectAttempt = 0;
      connect();
    },
    disconnect() {
      desired = false;
      clearReconnect();
      closeSocket();
      onState("closed", "Closed");
    },
    reconnect() {
      if (!activeSessionId) return;
      desired = true;
      reconnectAttempt = 0;
      connect();
    },
    send(data) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data));
    },
    resize: sendResize,
    dispose() {
      desired = false;
      activeSessionId = undefined;
      clearReconnect();
      closeSocket();
    },
  };
}
