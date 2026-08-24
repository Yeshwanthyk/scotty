#!/usr/bin/env bun
import {
  DESKTOP_PROTOCOL_VERSION,
  encodeDesktopFrame,
  type DesktopFrame,
} from "./desktop-protocol.ts";
import { TuiError, safeErrorMessage } from "./errors.ts";

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

const run = async (_args: ReadonlyArray<string>, _writer: StdoutFrameWriter): Promise<void> => {
  throw new TuiError(
    "config_missing",
    "The desktop sidecar requires a canonical client identity from the Scotty CLI; it does not read a TUI config file",
  );
};

const writer = new StdoutFrameWriter();
process.stdout.on("error", () => writer.fail());
const main = async (): Promise<void> => run(process.argv.slice(2), writer);

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
