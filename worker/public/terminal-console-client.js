export { PI_CONSOLE_PROTOCOL_VERSION } from "./terminal-console-protocol.js";

export function consoleUrl(sessionId, operation) {
  return `/s/${encodeURIComponent(sessionId)}/console/v1/${operation}`;
}

async function responseBody(response) {
  try {
    return { readable: true, value: await response.json() };
  } catch {
    return { readable: false, value: undefined };
  }
}

export function createConsoleClient({ fetch, eventSource, origin }) {
  return {
    async snapshot(sessionId, signal) {
      const response = await fetch(consoleUrl(sessionId, "snapshot"), {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal,
      });
      const body = await responseBody(response);
      if (!response.ok)
        throw new Error(
          body.value?.error?.message ?? `Could not load Pi session (${response.status})`,
        );
      if (!body.readable) throw new Error("Scotty returned an unreadable Pi session snapshot");
      return body.value;
    },

    events(sessionId, { epoch, sequence }) {
      const url = new URL(consoleUrl(sessionId, "events"), origin);
      if (epoch) url.searchParams.set("epoch", epoch);
      if (sequence) url.searchParams.set("since", String(sequence));
      return eventSource(url);
    },

    async command(sessionId, envelope) {
      const response = await fetch(consoleUrl(sessionId, "command"), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
      const body = await responseBody(response);
      return {
        ok: response.ok,
        status: response.status,
        readable: body.readable,
        body: body.value,
      };
    },
  };
}
