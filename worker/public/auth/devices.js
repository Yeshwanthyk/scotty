const elements = {
  cancelTransfer: document.querySelector("#cancel-transfer"),
  clients: document.querySelector("#clients"),
  clientsError: document.querySelector("#clients-error"),
  copyPairing: document.querySelector("#copy-pairing"),
  copyTransfer: document.querySelector("#copy-transfer"),
  issue: document.querySelector("#issue"),
  issueError: document.querySelector("#issue-error"),
  label: document.querySelector("#pair-label"),
  loading: document.querySelector("#loading"),
  pairing: document.querySelector("#pairing"),
  pairingExpires: document.querySelector("#pairing-expires"),
  pairingQr: document.querySelector("#pair-qr"),
  pairingUrl: document.querySelector("#pairing-url"),
  refresh: document.querySelector("#refresh"),
  transferError: document.querySelector("#transfer-error"),
  transferExpires: document.querySelector("#transfer-expires"),
  transferNote: document.querySelector("#transfer-note"),
  transferPanel: document.querySelector("#transfer-panel"),
  transferQr: document.querySelector("#transfer-qr"),
  transferShare: document.querySelector("#transfer-share"),
  transferSummary: document.querySelector("#transfer-summary"),
  transferUrl: document.querySelector("#transfer-url"),
};

const revokeConfirmations = new Set();
const transferConfirmations = new Set();
let knownClients = [];
let pendingTransfer = null;
let pairingLink = "";
let transferLink = "";
let pairingTimer;
let transferTimer;

function age(iso) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

async function errorMessage(response, fallback) {
  try {
    const body = await response.json();
    return body?.error?.message || fallback;
  } catch {
    return fallback;
  }
}

async function fetchJson(path, init, fallback) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", ...init?.headers },
    ...init,
  });
  if (!response.ok) throw new Error(await errorMessage(response, fallback));
  return response.json();
}

function renderQr(canvas, matrix) {
  if (!matrix || !Number.isInteger(matrix.size) || !Array.isArray(matrix.rows)) return false;
  const quiet = 4;
  const modules = matrix.size + quiet * 2;
  const scale = Math.max(4, Math.floor(320 / modules));
  canvas.width = modules * scale;
  canvas.height = modules * scale;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#071018";
  matrix.rows.forEach((row, y) => {
    if (typeof row !== "string" || row.length !== matrix.size) return;
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] === "1") context.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  });
  return true;
}

function countdown(element, expiresAt, expiredCopy, timerName) {
  const update = () => {
    const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
    element.textContent = seconds ? `Expires in ${seconds}s` : expiredCopy;
  };
  if (timerName === "pairing") {
    clearInterval(pairingTimer);
    pairingTimer = setInterval(update, 1000);
  } else {
    clearInterval(transferTimer);
    transferTimer = setInterval(update, 1000);
  }
  update();
}

function badge(text, primary = false) {
  const element = document.createElement("span");
  element.className = primary ? "badge badge-primary" : "badge";
  element.textContent = text;
  return element;
}

function actionButton(action, id, text, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${className}`.trim();
  button.dataset.action = action;
  button.dataset.id = id;
  button.textContent = text;
  return button;
}

function clientElement(client) {
  const item = document.createElement("li");
  item.className = "client";
  const identity = document.createElement("div");
  const title = document.createElement("p");
  title.className = "client-label";
  const name = document.createElement("span");
  name.textContent = client.label || "Browser";
  title.append(name);
  if (client.role === "owner") title.append(badge("Primary", true));
  if (client.current) title.append(badge("This device"));
  const meta = document.createElement("div");
  meta.className = "client-meta";
  meta.textContent = `${client.id} · last used ${age(client.lastSeenAt)}`;
  identity.append(title, meta);
  item.append(identity);

  const actions = document.createElement("div");
  actions.className = "client-actions";
  if (client.role === "standard") {
    const transferText = transferConfirmations.has(client.id) ? "Confirm primary" : "Make primary";
    const transfer = actionButton("transfer", client.id, transferText);
    transfer.disabled = Boolean(pendingTransfer);
    actions.append(transfer);
    const revokeText = revokeConfirmations.has(client.id) ? "Confirm revoke" : "Revoke";
    actions.append(actionButton("revoke", client.id, revokeText, "button-danger"));
  }
  item.append(actions);
  return item;
}

function renderClients() {
  elements.clients.replaceChildren(...knownClients.map(clientElement));
  elements.loading.hidden = true;
}

function clientName(id) {
  const client = knownClients.find((candidate) => candidate.id === id);
  return client?.label || id;
}

function renderTransfer() {
  elements.transferPanel.hidden = !pendingTransfer;
  if (!pendingTransfer) {
    elements.transferShare.hidden = true;
    elements.transferNote.textContent = "";
    renderClients();
    return;
  }
  elements.transferSummary.textContent = `Waiting for ${clientName(
    pendingTransfer.targetClientId,
  )} to accept before ${new Date(pendingTransfer.expiresAt).toLocaleTimeString()}.`;
  countdown(
    elements.transferExpires,
    pendingTransfer.expiresAt,
    "Expired · cancel or refresh",
    "transfer",
  );
  elements.transferShare.hidden = !transferLink;
  elements.transferNote.textContent = transferLink
    ? "The transfer completes only after an explicit click on the exact target browser."
    : "The secret link is shown only once. Cancel this transfer and create another if it was lost.";
  renderClients();
}

async function issuePairing() {
  if (elements.issue.disabled) return;
  elements.issue.disabled = true;
  elements.issue.textContent = "Creating…";
  elements.issueError.hidden = true;
  try {
    const pairingLabel = elements.label.value.trim();
    const body = await fetchJson(
      "/api/auth/pairings",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pairingLabel ? { label: pairingLabel } : {}),
      },
      "Couldn't create a pairing link.",
    );
    if (
      typeof body?.url !== "string" ||
      typeof body?.expiresAt !== "string" ||
      !renderQr(elements.pairingQr, body.qr)
    )
      throw new Error("Scotty returned an invalid pairing.");
    pairingLink = body.url;
    elements.pairingUrl.textContent = body.url;
    elements.pairing.hidden = false;
    countdown(
      elements.pairingExpires,
      body.expiresAt,
      "Expired · create a fresh pairing",
      "pairing",
    );
  } catch (error) {
    elements.issueError.textContent =
      error instanceof Error ? error.message : "Couldn't create a pairing link.";
    elements.issueError.hidden = false;
  } finally {
    elements.issue.disabled = false;
    elements.issue.textContent = "Create pairing";
  }
}

async function loadAuthority() {
  elements.refresh.disabled = true;
  elements.clientsError.hidden = true;
  try {
    const [clients, transfer] = await Promise.all([
      fetchJson("/api/auth/clients", undefined, "Couldn't load registered browsers."),
      fetchJson(
        "/api/auth/owner-transfers/current",
        undefined,
        "Couldn't load the pending transfer.",
      ),
    ]);
    if (!Array.isArray(clients)) throw new Error("Scotty returned an invalid client list.");
    knownClients = clients;
    pendingTransfer = transfer;
    if (!pendingTransfer) transferLink = "";
    renderClients();
    renderTransfer();
  } catch (error) {
    elements.clientsError.textContent =
      error instanceof Error ? error.message : "Couldn't load registered browsers.";
    elements.clientsError.hidden = false;
  } finally {
    elements.refresh.disabled = false;
  }
}

async function revoke(id, button) {
  if (!revokeConfirmations.has(id)) {
    revokeConfirmations.add(id);
    button.textContent = "Confirm revoke";
    return;
  }
  button.disabled = true;
  button.textContent = "Revoking…";
  try {
    await fetchJson(
      `/api/auth/clients/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      "Couldn't revoke this browser.",
    );
    revokeConfirmations.delete(id);
    await loadAuthority();
  } catch (error) {
    elements.clientsError.textContent =
      error instanceof Error ? error.message : "Couldn't revoke this browser.";
    elements.clientsError.hidden = false;
    button.disabled = false;
    button.textContent = "Confirm revoke";
  }
}

async function startTransfer(id, button) {
  if (!transferConfirmations.has(id)) {
    transferConfirmations.add(id);
    button.textContent = "Confirm primary";
    return;
  }
  button.disabled = true;
  button.textContent = "Creating…";
  elements.transferError.hidden = true;
  try {
    const body = await fetchJson(
      "/api/auth/owner-transfers",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ targetClientId: id }),
      },
      "Couldn't create the ownership transfer.",
    );
    if (
      typeof body?.id !== "string" ||
      typeof body?.url !== "string" ||
      !renderQr(elements.transferQr, body.qr)
    )
      throw new Error("Scotty returned an invalid ownership transfer.");
    pendingTransfer = body;
    transferLink = body.url;
    elements.transferUrl.textContent = body.url;
    transferConfirmations.clear();
    renderTransfer();
  } catch (error) {
    elements.clientsError.textContent =
      error instanceof Error ? error.message : "Couldn't create the ownership transfer.";
    elements.clientsError.hidden = false;
    button.disabled = false;
    button.textContent = "Confirm primary";
  }
}

async function cancelTransfer() {
  if (!pendingTransfer || elements.cancelTransfer.disabled) return;
  elements.cancelTransfer.disabled = true;
  elements.cancelTransfer.textContent = "Cancelling…";
  elements.transferError.hidden = true;
  try {
    await fetchJson(
      `/api/auth/owner-transfers/${encodeURIComponent(pendingTransfer.id)}`,
      { method: "DELETE" },
      "Couldn't cancel the ownership transfer.",
    );
    pendingTransfer = null;
    transferLink = "";
    renderTransfer();
  } catch (error) {
    elements.transferError.textContent =
      error instanceof Error ? error.message : "Couldn't cancel the ownership transfer.";
    elements.transferError.hidden = false;
  } finally {
    elements.cancelTransfer.disabled = false;
    elements.cancelTransfer.textContent = "Cancel transfer";
  }
}

async function copyLink(value, button, original) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = original;
    }, 1500);
  } catch {
    button.textContent = "Copy failed";
  }
}

elements.issue.addEventListener("click", () => void issuePairing());
elements.refresh.addEventListener("click", () => void loadAuthority());
elements.cancelTransfer.addEventListener("click", () => void cancelTransfer());
elements.copyPairing.addEventListener(
  "click",
  () => void copyLink(pairingLink, elements.copyPairing, "Copy pairing link"),
);
elements.copyTransfer.addEventListener(
  "click",
  () => void copyLink(transferLink, elements.copyTransfer, "Copy transfer link"),
);
elements.clients.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest("button[data-action][data-id]");
  if (!(button instanceof HTMLButtonElement) || !button.dataset.id) return;
  if (button.dataset.action === "revoke") void revoke(button.dataset.id, button);
  if (button.dataset.action === "transfer") void startTransfer(button.dataset.id, button);
});

void loadAuthority();
