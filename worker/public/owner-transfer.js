const card = document.querySelector("#card");
const button = document.querySelector("#accept");
const status = document.querySelector("#status");
const token = new URLSearchParams(location.hash.slice(1)).get("token");

history.replaceState({}, "", location.pathname);

async function acceptTransfer() {
  if (!token || button.disabled) return;
  button.disabled = true;
  button.textContent = "Transferring…";
  status.dataset.kind = "";
  status.textContent = "Rotating this device's credential.";
  try {
    const response = await fetch("/api/auth/owner-transfers/accept", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) throw new Error("This transfer is invalid, expired, or for another device.");
    const body = await response.json();
    if (body?.client?.role !== "owner")
      throw new Error("This transfer is invalid, expired, or for another device.");
    card.dataset.state = "success";
  } catch {
    status.dataset.kind = "error";
    status.textContent = "This transfer is invalid, expired, or for another device.";
    button.disabled = false;
    button.textContent = "Try again";
  }
}

if (!token) {
  status.dataset.kind = "error";
  status.textContent = "This transfer is invalid, expired, or for another device.";
  button.disabled = true;
}
button.addEventListener("click", () => void acceptTransfer());
