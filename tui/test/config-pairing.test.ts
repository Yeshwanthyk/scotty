import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { defaultStateDirectory, normalizeOrigin } from "../src/config.ts";
import { consumePairing } from "../src/pairing.ts";
import { readSecretLine } from "../src/secret-input.ts";
import type { FetchImplementation } from "../src/transport.ts";

const CLIENT_CREDENTIAL = `scotty_client.0123456789ab.${"c".repeat(32)}`;
const PAIRING_CREDENTIAL = `scotty_pair.abcdef012345.${"p".repeat(32)}`;

describe("TUI config boundary", () => {
  it("keeps TUI state under the XDG state root while identity stays CLI-owned", () => {
    const previousState = process.env.XDG_STATE_HOME;
    const previousConfig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_STATE_HOME = "/tmp/scotty-xdg-state";
    process.env.XDG_CONFIG_HOME = "/tmp/scotty-xdg-config";
    try {
      expect(defaultStateDirectory()).toBe("/tmp/scotty-xdg-state/scotty/tui");
    } finally {
      if (previousState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousState;
      if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfig;
    }
  });

  it("normalizes only exact installation origins", () => {
    expect(normalizeOrigin("https://scotty.example/")).toBe("https://scotty.example");
    expect(normalizeOrigin("http://localhost/")).toBe("http://localhost");
    expect(() => normalizeOrigin("https://scotty.example/path")).toThrow(
      "Origin must not contain credentials, a path, or query",
    );
    expect(() => normalizeOrigin("https://scotty.example?query")).toThrow(
      "Origin must not contain credentials, a path, or query",
    );
    expect(() => normalizeOrigin("http://scotty.example")).toThrow(
      "Origin must use HTTPS (or localhost HTTP)",
    );
  });
});

class PairingInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModes: boolean[] = [];

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawModes.push(mode);
  }

  resume(): void {}
  pause(): void {}
}

describe("pairing input", () => {
  it("does not echo a pairing credential in a TTY", async () => {
    const input = new PairingInput();
    const output: string[] = [];
    const result = readSecretLine("Pairing credential or URL: ", input, {
      write: (text) => output.push(text),
    });
    input.emit("data", Buffer.from(`${PAIRING_CREDENTIAL}\r`));

    await expect(result).resolves.toBe(PAIRING_CREDENTIAL);
    expect(input.rawModes).toEqual([true, false]);
    expect(output.join("")).toBe("Pairing credential or URL: \n");
    expect(output.join("")).not.toContain(PAIRING_CREDENTIAL);
  });

  it("restores the terminal and fails on empty EOF", async () => {
    const input = new PairingInput();
    const output: string[] = [];
    const result = readSecretLine("Pairing credential or URL: ", input, {
      write: (text) => output.push(text),
    });
    input.emit("end");

    await expect(result).rejects.toMatchObject({
      code: "input_invalid",
      message: "Pairing input ended before a credential was entered",
    });
    expect(input.rawModes).toEqual([true, false]);
    expect(output.join("")).toBe("Pairing credential or URL: \n");
  });

  it("accepts a piped credential that ends without a newline", async () => {
    const input = new PairingInput();
    input.isTTY = false;
    const output: string[] = [];
    const result = readSecretLine("Pairing credential or URL: ", input, {
      write: (text) => output.push(text),
    });
    input.emit("data", Buffer.from(PAIRING_CREDENTIAL));
    input.emit("end");

    await expect(result).resolves.toBe(PAIRING_CREDENTIAL);
    expect(input.rawModes).toEqual([]);
    expect(output.join("")).not.toContain(PAIRING_CREDENTIAL);
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
