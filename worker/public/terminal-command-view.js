const localStateLabel = {
  queued: "Waiting to send",
  sending: "Sending",
  rejected: "Not accepted",
  stale: "Held · session changed",
  ambiguous: "Held · outcome unknown",
  paused: "Held · command lane paused",
};

function receipt(document, title, text, className = "") {
  const element = document.createElement("div");
  element.className = `receipt ${className}`.trim();
  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement("span");
  copy.textContent = text;
  element.append(heading, copy);
  return element;
}

export function renderCommandReceipts(document, target, serverQueue, localItems) {
  const fragment = document.createDocumentFragment();
  for (const item of localItems) {
    fragment.append(
      receipt(document, localStateLabel[item.state] ?? "Pending", item.label, "local"),
    );
  }
  for (const [kind, items] of [
    ["steer", serverQueue.steer],
    ["follow_up", serverQueue.followUp],
  ]) {
    items.forEach((item, index) => {
      fragment.append(
        receipt(
          document,
          kind === "steer" ? "Steering next" : `Queued ${index + 1}`,
          item.text,
          kind === "steer" ? "steer" : "",
        ),
      );
    });
  }
  target.replaceChildren(fragment);
}
