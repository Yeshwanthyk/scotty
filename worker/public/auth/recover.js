const button = document.querySelector("#recover");
const status = document.querySelector("#status");
const token = new URLSearchParams(location.hash.slice(1)).get("token");

history.replaceState({}, "", location.pathname);

async function recover() {
  if (!token || button.disabled) return;
  button.disabled = true;
  button.textContent = "Resetting browser access…";
  status.dataset.kind = "";
  status.textContent = "Creating a fresh primary credential.";
  try {
    const response = await fetch("/api/auth/recovery-grants/consume", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) throw new Error("This recovery link is invalid or expired.");
    const body = await response.json();
    if (body?.client?.role !== "owner")
      throw new Error("This recovery link is invalid or expired.");
    location.replace("/sessions");
  } catch {
    status.dataset.kind = "error";
    status.textContent = "This recovery link is invalid or expired. Run recovery again.";
    button.disabled = false;
    button.textContent = "Try again";
  }
}

if (!token) {
  status.dataset.kind = "error";
  status.textContent = "This recovery link is invalid or expired. Run recovery again.";
  button.disabled = true;
}
button.addEventListener("click", () => void recover());
