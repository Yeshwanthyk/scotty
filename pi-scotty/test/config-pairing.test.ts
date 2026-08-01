import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultStateDirectory, loadConfig, saveConfig } from "../src/config.ts";
import { consumePairing } from "../src/pairing.ts";
import type { FetchImplementation } from "../src/transport.ts";

const CLIENT_CREDENTIAL = `scotty_client.0123456789ab.${"c".repeat(32)}`;
const PAIRING_CREDENTIAL = `scotty_pair.abcdef012345.${"p".repeat(32)}`;

describe("paired-client config", () => {
  it("owns its XDG state directory independently of Pi", () => {
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/tmp/scotty-xdg-state";
    try {
      expect(defaultStateDirectory()).toBe("/tmp/scotty-xdg-state/pi-scotty");
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
  });

  it("stores only the exact origin and standard-client cookie with mode 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-scotty-config-"));
    const path = join(directory, "config.json");
    await saveConfig(
      { version: 1, origin: "https://scotty.example", credential: CLIENT_CREDENTIAL },
      path,
    );

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadConfig(path)).toEqual({
      version: 1,
      origin: "https://scotty.example",
      credential: CLIENT_CREDENTIAL,
    });
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("SCOTTY_TOKEN");
    expect(text).not.toContain("PI_CODING_AGENT_DIR");
  });

  it("rejects group/world-readable config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-scotty-mode-"));
    const path = join(directory, "config.json");
    await saveConfig(
      { version: 1, origin: "https://scotty.example", credential: CLIENT_CREDENTIAL },
      path,
    );
    await chmod(path, 0o644);

    await expect(loadConfig(path)).rejects.toMatchObject({ code: "config_permissions" });
  });
});

describe("pairing consume", () => {
  it("posts the one-use token only in a same-origin JSON body and captures the cookie", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const fetch: FetchImplementation = async (input, init) => {
      requests.push({ url: input.toString(), init });
      return Response.json(
        { client: { id: "0123456789ab" } },
        { headers: { "set-cookie": `__Host-scotty=${CLIENT_CREDENTIAL}; Secure; HttpOnly` } },
      );
    };

    const config = await consumePairing({
      origin: "https://scotty.example",
      pairingInput: `https://scotty.example/pair#token=${PAIRING_CREDENTIAL}`,
      label: "terminal",
      fetch,
    });

    expect(config).toEqual({
      version: 1,
      origin: "https://scotty.example",
      credential: CLIENT_CREDENTIAL,
    });
    expect(requests[0].url).toBe("https://scotty.example/api/auth/pairings/consume");
    expect(requests[0].url).not.toContain(PAIRING_CREDENTIAL);
    expect(requests[0].init?.method).toBe("POST");
    expect(new Headers(requests[0].init?.headers).get("origin")).toBe("https://scotty.example");
    expect(new Headers(requests[0].init?.headers).get("sec-fetch-site")).toBe("same-origin");
    expect(requests[0].init?.body).toContain(PAIRING_CREDENTIAL);
  });
});
