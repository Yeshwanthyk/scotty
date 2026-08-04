import { PiScottyError } from "./errors.ts";

interface SecretInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: "end" | "close", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}

interface SecretOutput {
  write(text: string): unknown;
}

export const readSecretLine = async (
  prompt: string,
  input: SecretInput = process.stdin,
  output: SecretOutput = process.stdout,
): Promise<string> => {
  output.write(prompt);
  const useRawMode = input.isTTY === true && input.setRawMode !== undefined;
  const wasRaw = input.isRaw === true;
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (
      result: { readonly value: string } | { readonly error: PiScottyError },
    ): void => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      input.removeListener("error", onError);
      if (useRawMode) input.setRawMode?.(wasRaw);
      input.pause();
      output.write("\n");
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const ended = (): void =>
      finish(
        value.length > 0
          ? { value }
          : {
              error: new PiScottyError(
                "input_invalid",
                "Pairing input ended before a credential was entered",
              ),
            },
      );
    const onEnd = (): void => ended();
    const onError = (): void =>
      finish({ error: new PiScottyError("input_invalid", "Pairing input could not be read") });
    const onData = (chunk: Buffer | string): void => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          finish({ value });
          return;
        }
        if (character === "\u0003") {
          finish({ error: new PiScottyError("input_invalid", "Pairing cancelled") });
          return;
        }
        if (character === "\u0004") {
          ended();
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("close", onEnd);
    input.on("error", onError);
    if (useRawMode) input.setRawMode?.(true);
    input.resume();
  });
};
