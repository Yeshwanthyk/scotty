import { FitAddon, init, Terminal } from "/vendor/ghostty-web.js";
import { groupSessionsByRepository, sessionTitle } from "/session-form.js";

const sessionMatch = window.location.pathname.match(/^\/s\/([^/]+)$/u);
const sessionId = sessionMatch ? decodeURIComponent(sessionMatch[1]) : "";
const terminalElement = document.querySelector("#terminal");
const workspaceList = document.querySelector("#workspace-list");
const currentRepo = document.querySelector("#current-repo");
const currentMeta = document.querySelector("#current-meta");
const pickerTitle = document.querySelector("#picker-title");
const pickerProject = document.querySelector("#picker-project");
const connectionState = document.querySelector("#connection-state");
const connectionLabel = document.querySelector("#connection-label");
const terminalError = document.querySelector("#terminal-error");
const terminalErrorMessage = document.querySelector("#terminal-error-message");
const reconnectButton = document.querySelector("#reconnect");
const openDrawerButton = document.querySelector("#open-drawer");
const closeDrawerButton = document.querySelector("#close-drawer");
const drawerBackdrop = document.querySelector("#drawer-backdrop");
const terminalWorkspace = document.querySelector(".terminal-workspace");
const workspaceRail = document.querySelector("#workspace-rail");
const compactViewport = window.matchMedia("(max-width: 780px)");

let socket;
let reconnectTimer;
let reconnectAttempt = 0;
let disposed = false;
let terminal;
let fitAddon;
let workspaceListSignature;

function setConnection(state, label) {
  connectionState.dataset.state = state;
  connectionLabel.textContent = label;
}

function showError(message) {
  terminalErrorMessage.textContent = message;
  terminalError.hidden = false;
}

function hideError() {
  terminalError.hidden = true;
}

function setDrawer(open) {
  const isOpen = compactViewport.matches && open;
  document.body.classList.toggle("drawer-open", isOpen);
  drawerBackdrop.hidden = !isOpen;
  openDrawerButton.setAttribute("aria-expanded", String(isOpen));
  if (isOpen) {
    workspaceRail.setAttribute("role", "dialog");
    workspaceRail.setAttribute("aria-modal", "true");
  } else {
    workspaceRail.removeAttribute("role");
    workspaceRail.removeAttribute("aria-modal");
  }
  terminalWorkspace.inert = isOpen;
  if (isOpen) closeDrawerButton.focus();
  else if (compactViewport.matches) openDrawerButton.focus();
}

function workspaceName(session) {
  return sessionTitle(session);
}

function addWorkspaceLink(parent, session) {
  const link = document.createElement("a");
  link.className = "workspace-link";
  link.href = `/s/${encodeURIComponent(session.id)}`;
  link.dataset.sessionId = session.id;
  if (session.id === sessionId) link.setAttribute("aria-current", "page");

  const copy = document.createElement("span");
  copy.className = "workspace-copy";
  const name = document.createElement("span");
  name.className = "workspace-name";
  name.textContent = workspaceName(session);
  copy.append(name);
  link.append(copy);
  parent.append(link);
}

function addWorkspaceProject(group) {
  const section = document.createElement("section");
  section.className = "workspace-project";
  const name = document.createElement("h2");
  name.className = "workspace-project-name";
  name.textContent = group.repo;
  section.append(name);
  for (const session of group.sessions) addWorkspaceLink(section, session);
  workspaceList.append(section);
}

function focusableDrawerElements() {
  return [
    ...document.querySelectorAll("#workspace-rail a[href], #workspace-rail button:not([disabled])"),
  ].filter((element) => element.getClientRects().length > 0);
}

function visibleWorkspaceSignature(groups) {
  return JSON.stringify(
    groups.map((group) => [
      group.repo,
      group.sessions.map((session) => [session.id, workspaceName(session)]),
    ]),
  );
}

async function loadWorkspaces() {
  const response = await fetch("/api/sessions", {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not load open containers (${response.status})`);
  const body = await response.json();
  const sessions = Array.isArray(body) ? body : body?.sessions;
  if (!Array.isArray(sessions)) throw new Error("Scotty returned an invalid session list");
  const warm = sessions.filter((session) => session?.status === "warm");
  const groups = groupSessionsByRepository(warm);
  const signature = visibleWorkspaceSignature(groups);
  if (signature !== workspaceListSignature) {
    const focusedSessionId =
      document.activeElement?.closest?.(".workspace-link")?.dataset.sessionId;
    workspaceList.replaceChildren();
    if (warm.length === 0) {
      const message = document.createElement("p");
      message.className = "rail-message";
      message.textContent = "No open containers. Resume one from Home.";
      workspaceList.append(message);
    } else {
      for (const group of groups) addWorkspaceProject(group);
    }
    workspaceListSignature = signature;
    if (focusedSessionId) {
      const restoredLink = [...workspaceList.querySelectorAll(".workspace-link")].find(
        (link) => link.dataset.sessionId === focusedSessionId,
      );
      restoredLink?.focus();
    }
  }
  const current = sessions.find((session) => session?.id === sessionId);
  if (current) {
    const title = workspaceName(current);
    currentRepo.textContent = title;
    currentMeta.textContent = `${current.repo || "Unknown project"} · ${
      current.branch || current.id
    }`;
    pickerTitle.textContent = title;
    pickerProject.textContent = current.repo || current.branch || current.id;
    document.title = `${workspaceName(current)} · Scotty`;
  }
}

function scheduleReconnect() {
  if (disposed || reconnectTimer) return;
  const delay = Math.min(15000, 500 * 2 ** Math.min(reconnectAttempt, 5));
  reconnectAttempt += 1;
  setConnection("connecting", `Reconnecting in ${Math.ceil(delay / 1000)}s`);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
}

function sendResize() {
  if (socket?.readyState !== WebSocket.OPEN || !terminal) return;
  socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
}

function handleControlMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "ready") {
    reconnectAttempt = 0;
    hideError();
    setConnection("connected", "Connected");
    sendResize();
    terminal.focus();
    return;
  }
  if (message.type === "error") {
    showError(message.message || "The terminal reported an error.");
    return;
  }
  if (message.type === "exit") {
    showError(`Pi exited with code ${message.code ?? "unknown"}. Reconnect to continue.`);
    setConnection("disconnected", "Exited");
  }
}

function connect() {
  if (!sessionId || disposed) return;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  hideError();
  setConnection("connecting", reconnectAttempt ? "Reconnecting" : "Connecting");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(
    `${protocol}//${window.location.host}/s/${encodeURIComponent(sessionId)}/terminal`,
  );
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", sendResize);
  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      terminal.write(new Uint8Array(event.data));
      return;
    }
    if (typeof event.data !== "string") return;
    try {
      handleControlMessage(JSON.parse(event.data));
    } catch {
      // Ignore non-control text frames. PTY output is always binary.
    }
  });
  socket.addEventListener("close", () => {
    if (disposed) return;
    setConnection("disconnected", "Disconnected");
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    setConnection("disconnected", "Connection error");
  });
}

async function startTerminal() {
  if (!sessionId) {
    showError("This URL does not identify a Scotty session.");
    return;
  }
  await init();
  terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: '"SFMono-Regular", "Cascadia Mono", Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1.18,
    scrollback: 10000,
    theme: {
      background: "#05090d",
      foreground: "#d8dfdd",
      cursor: "#d8c598",
      cursorAccent: "#05090d",
      selectionBackground: "#28434e",
      black: "#101820",
      red: "#d8837e",
      green: "#7fb492",
      yellow: "#ceb475",
      blue: "#7ca4bd",
      magenta: "#b99ab5",
      cyan: "#79afb9",
      white: "#d8dfdd",
      brightBlack: "#65747a",
      brightRed: "#e69892",
      brightGreen: "#91c5a4",
      brightYellow: "#dfc889",
      brightBlue: "#91bad1",
      brightMagenta: "#cbaec7",
      brightCyan: "#8dc4ce",
      brightWhite: "#f2f3ee",
    },
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalElement);
  fitAddon.fit();
  terminal.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data));
  });
  terminal.onResize(sendResize);
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
  });
  resizeObserver.observe(terminalElement);
  connect();
}

openDrawerButton.addEventListener("click", () => setDrawer(true));
closeDrawerButton.addEventListener("click", () => setDrawer(false));
drawerBackdrop.addEventListener("click", () => setDrawer(false));
reconnectButton.addEventListener("click", () => {
  reconnectAttempt = 0;
  window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  connect();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("drawer-open")) setDrawer(false);
  if (event.key === "Tab" && document.body.classList.contains("drawer-open")) {
    const elements = focusableDrawerElements();
    const first = elements[0];
    const last = elements.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    setDrawer(!document.body.classList.contains("drawer-open"));
  }
});
compactViewport.addEventListener("change", (event) => {
  if (!event.matches) setDrawer(false);
});
window.addEventListener("beforeunload", () => {
  disposed = true;
  window.clearTimeout(reconnectTimer);
  socket?.close();
});

Promise.all([loadWorkspaces(), startTerminal()]).catch((error) => {
  const message = error instanceof Error ? error.message : "Unable to open the terminal.";
  showError(message);
  setConnection("disconnected", "Unavailable");
});

window.setInterval(() => {
  loadWorkspaces().catch(() => {});
}, 15000);
