const card = document.querySelector("#card");
const button = document.querySelector("#pair");
const label = document.querySelector("#label");
const status = document.querySelector("#status");
const token = new URLSearchParams(location.hash.slice(1)).get("token");

history.replaceState({}, "", location.pathname);

function defaultLabel() {
  if (/iPhone|iPad/iu.test(navigator.userAgent)) return "My iPhone or iPad";
  if (/Android/iu.test(navigator.userAgent)) return "My Android device";
  if (/Helium/iu.test(navigator.userAgent)) return "Helium browser";
  return "My browser";
}

async function errorMessage(response) {
  try {
    const body = await response.json();
    return body?.error?.message || "This pairing link couldn't be used.";
  } catch {
    return "This pairing link couldn't be used.";
  }
}

async function pair() {
  if (!token || button.disabled) return;
  button.disabled = true;
  button.textContent = "Pairing…";
  status.dataset.kind = "";
  status.textContent = "Registering this browser with Scotty.";
  try {
    const response = await fetch("/api/auth/pairings/consume", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ token, label: label.value.trim() || defaultLabel() }),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    const body = await response.json();
    if (typeof body?.client?.id !== "string")
      throw new Error("Scotty returned an invalid response.");
    card.dataset.state = "success";
  } catch (error) {
    status.dataset.kind = "error";
    status.textContent = `${
      error instanceof Error ? error.message : "Pairing failed."
    } Ask the primary device for a fresh link.`;
    button.disabled = false;
    button.textContent = "Try again";
  }
}

label.value = defaultLabel();
if (!token) {
  status.dataset.kind = "error";
  status.textContent =
    "This pairing link is missing its one-time token. Ask the primary device for a fresh link.";
  button.disabled = true;
}
button.addEventListener("click", () => void pair());
