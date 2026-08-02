#!/usr/bin/env bun
import { defaultConfigPath, loadConfig, saveConfig } from "./config.ts";
import {
  DESKTOP_MAX_COMMAND_BYTES,
  DESKTOP_PROTOCOL_VERSION,
  encodeDesktopFrame,
  type DesktopFrame,
} from "./desktop-protocol.ts";
import { makeDesktopSidecar } from "./desktop-sidecar.ts";
import { safeErrorMessage } from "./errors.ts";
import { HttpConsoleTransport } from "./transport.ts";

const encoder = new TextEncoder();

const configPathFromArguments = (args: ReadonlyArray<string>): string => {
  if (args.length === 0) return defaultConfigPath();
  if (args.length === 2 && args[0] === "--config" && args[1] !== undefined) return args[1];
  throw new TypeError("Usage: scotty-console-sidecar [--config PATH]");
};

class StdoutFrameWriter {
  readonly #controls: string[] = [];
  readonly #drainers: Array<() => void> = [];
  #state: string | undefined;
  #writing = false;
  #failed = false;

  write(frame: DesktopFrame): void {
    if (this.#failed) return;
    const fitted = encodeDesktopFrame(frame);
    const encoded =
      fitted ??
      `${JSON.stringify({
        version: DESKTOP_PROTOCOL_VERSION,
        type: "error",
        code: "frame_too_large",
        message: "Desktop state exceeded its size limit",
      })}\n`;
    if (frame.type === "state" && fitted !== undefined) this.#state = encoded;
    else {
      if (this.#controls.length === 16) this.#controls.shift();
      this.#controls.push(encoded);
    }
    this.#flush();
  }

  fail(): void {
    this.#failed = true;
    this.#controls.length = 0;
    this.#state = undefined;
    this.#finishDrains();
  }

  drain(): Promise<void> {
    if (
      (!this.#writing && this.#controls.length === 0 && this.#state === undefined) ||
      this.#failed
    )
      return Promise.resolve();
    return new Promise((resolve) => this.#drainers.push(resolve));
  }

  #flush(): void {
    if (this.#writing || this.#failed) return;
    const control = this.#controls.shift();
    const next = control ?? this.#state;
    if (next === undefined) {
      this.#finishDrains();
      return;
    }
    if (control === undefined) this.#state = undefined;
    this.#writing = true;
    process.stdout.write(next, (error) => {
      this.#writing = false;
      if (error) this.fail();
      else this.#flush();
    });
  }

  #finishDrains(): void {
    for (const resolve of this.#drainers.splice(0)) resolve();
  }
}

const run = async (configPath: string, writer: StdoutFrameWriter): Promise<void> => {
  let config = await loadConfig(configPath);
  const transport = new HttpConsoleTransport(config, {
    onCredential: async (credential) => {
      config = { ...config, credential };
      await saveConfig(config, configPath);
    },
  });
  const sidecar = makeDesktopSidecar(transport, (frame) => writer.write(frame));
  await sidecar.start();

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      if (line && !(await sidecar.handleLine(line))) {
        await writer.drain();
        return;
      }
      newline = buffer.indexOf("\n");
    }
    if (encoder.encode(buffer).byteLength > DESKTOP_MAX_COMMAND_BYTES) {
      await sidecar.handleLine(buffer);
      sidecar.stop();
      await writer.drain();
      return;
    }
  }
  const tail = `${buffer}${decoder.decode()}`.trim();
  if (tail) await sidecar.handleLine(tail);
  sidecar.stop();
  await writer.drain();
};

const writer = new StdoutFrameWriter();
process.stdout.on("error", () => writer.fail());
const main = async (): Promise<void> => run(configPathFromArguments(process.argv.slice(2)), writer);

if (import.meta.main)
  void main().catch(async (error: unknown) => {
    writer.write({
      version: DESKTOP_PROTOCOL_VERSION,
      type: "error",
      code: "command_failed",
      message: safeErrorMessage(error),
    });
    await writer.drain();
    process.exitCode = 1;
  });
