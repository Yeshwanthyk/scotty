import { Writable } from "node:stream";
import { intro, log, note, outro } from "@clack/prompts";
import type { Writer } from "./core";

export interface OwnerRecoveryUi {
  readonly start: () => void;
  readonly preparing: () => void;
  readonly preparationFailed: () => void;
  readonly issued: () => void;
  readonly opening: () => void;
  readonly failed: (expiresAt: string) => void;
  readonly complete: (expiresAt: string) => void;
}

const writerStream = (writer: Writer): Writable => {
  const output = new Writable({
    write(chunk, _encoding, callback) {
      writer(String(chunk));
      callback();
    },
  });
  Object.assign(output, { columns: 80, rows: 24, isTTY: true });
  return output;
};

export const makeOwnerRecoveryUi = (writer: Writer): OwnerRecoveryUi => {
  const output = writerStream(writer);
  return {
    start: () => intro("Scotty owner recovery", { output }),
    preparing: () => log.step("Preparing a short-lived, one-use recovery grant", { output }),
    preparationFailed: () => {
      log.error("Recovery handoff could not be prepared", { output });
      note(
        [
          "No browser handoff was opened.",
          "Resolve the reported configuration or connection error, then rerun this command.",
        ].join("\n"),
        "Recovery not started",
        { output },
      );
      outro("No recovery credential was printed or saved", { output });
    },
    issued: () => log.success("Recovery grant issued", { output }),
    opening: () => log.step("Opening the secure browser handoff", { output }),
    failed: (expiresAt) => {
      log.error("Browser handoff could not be opened", { output });
      note(
        [
          `The issued handoff expires at ${expiresAt}.`,
          "First check whether the recovery page opened.",
          "If not, fix your browser launcher, then rerun this command for a fresh handoff.",
        ].join("\n"),
        "Recovery not completed",
        { output },
      );
      outro("No recovery credential was printed or saved", { output });
    },
    complete: (expiresAt) => {
      log.success("Browser handoff opened", { output });
      note(
        [
          "Review the reset warning, then confirm recovery in the browser.",
          `The handoff expires at ${expiresAt}.`,
          "If no browser appeared, rerun this command to issue a fresh handoff.",
        ].join("\n"),
        "Finish in your browser",
        { output },
      );
      outro("No recovery credential was printed or saved", { output });
    },
  };
};
