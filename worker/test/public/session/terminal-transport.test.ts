import { assert, describe, it } from "vitest";
import {
  createTerminalConnection,
  terminalRestartUrl,
  terminalSocketUrl,
} from "../../../public/session/terminal-transport.js";

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly READY_STATE_CONNECTING = FakeSocket.CONNECTING;
  static readonly READY_STATE_OPEN = FakeSocket.OPEN;
  static readonly READY_STATE_CLOSING = FakeSocket.CLOSING;
  static readonly READY_STATE_CLOSED = FakeSocket.CLOSED;
  static readonly instances: FakeSocket[] = [];

  readonly listeners = new Map<string, Array<(event: { readonly data?: unknown }) => void>>();
  readonly sent: unknown[] = [];
  readonly url: string;
  binaryType = "";
  readyState = FakeSocket.CONNECTING;

  constructor(url: URL) {
    this.url = url.toString();
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: { readonly data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  send(value: unknown): void {
    this.sent.push(value);
  }
}

describe("session terminal browser transport", () => {
  it("builds same-origin socket and restart routes without exposing authority", () => {
    assert.strictEqual(
      terminalSocketUrl("session/a", "https://scotty.test", { cols: 120, rows: 32 }).toString(),
      "wss://scotty.test/s/session%2Fa/terminal?cols=120&rows=32",
    );
    assert.strictEqual(terminalRestartUrl("session/a"), "/s/session%2Fa/terminal/restart");
  });

  it("reconnects from the server PTY buffer without replaying browser input", () => {
    FakeSocket.instances.length = 0;
    const scheduled: Array<() => void> = [];
    const output: Uint8Array[] = [];
    const states: string[] = [];
    const connection = createTerminalConnection({
      WebSocket: FakeSocket,
      origin: "https://scotty.test",
      schedule: (callback: () => void) => {
        scheduled.push(callback);
        return 1;
      },
      cancel: () => undefined,
      dimensions: () => ({ cols: 90, rows: 28 }),
      onData: (data) => output.push(data),
      onState: (state) => states.push(state),
      onReady: () => undefined,
    });

    connection.connect("a0b1c2d3e4f5");
    const first = FakeSocket.instances[0]!;
    first.readyState = FakeSocket.OPEN;
    first.emit("message", { data: JSON.stringify({ type: "ready" }) });
    connection.send("pwd\r");
    first.emit("message", { data: Uint8Array.from([111, 107]).buffer });
    first.emit("close");

    assert.deepStrictEqual(Array.from(output[0] ?? []), [111, 107]);
    assert.strictEqual(scheduled.length, 1);
    scheduled[0]!();
    assert.strictEqual(FakeSocket.instances.length, 2);
    assert.strictEqual(FakeSocket.instances[1]!.sent.length, 0);
    assert.include(states, "reconnecting");
  });
});
