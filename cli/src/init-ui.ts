import { Writable } from "node:stream";
import { intro, note, outro } from "@clack/prompts";
import type { Writer } from "./core";

export interface InitReview {
  readonly installationName: string;
  readonly profile: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly runnerWorkerName: string;
  readonly containerName: string;
  readonly kvTitle: string;
  readonly backupBucketName: string;
  readonly previewBase: string;
  readonly previewZoneId: string;
}

export interface InitPhase {
  readonly succeed: (message: string) => void;
  readonly fail: (message: string) => void;
}

export interface InitUi {
  readonly start: () => void;
  readonly review: (review: InitReview) => void;
  readonly phase: (message: string) => InitPhase;
  readonly complete: () => void;
}

const elapsed = (startedAt: number): string => {
  const elapsedSeconds = Math.max(0, Math.floor((performance.now() - startedAt) / 1_000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
};

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

export const makeSilentInitUi = (): InitUi => ({
  start: () => undefined,
  review: () => undefined,
  phase: () => ({ succeed: () => undefined, fail: () => undefined }),
  complete: () => undefined,
});

export const makeInitUi = (writer: Writer): InitUi => {
  const output = writerStream(writer);

  return {
    start: (): void => intro("Scotty init", { output }),
    review: (review: InitReview): void =>
      note(
        [
          `Installation  ${review.installationName}`,
          `Profile       ${review.profile}`,
          `Account       ${review.accountId}`,
          "",
          `Worker        ${review.workerName}`,
          `Runner        ${review.runnerWorkerName}`,
          `Container     ${review.containerName}`,
          `Sessions KV   ${review.kvTitle}`,
          `Backups R2    ${review.backupBucketName}`,
          "",
          `Preview       ${review.previewBase}`,
          `Zone          ${review.previewZoneId}`,
          "Hatch         enabled",
          "Evidence      enabled",
        ].join("\n"),
        "Installation review",
        { output },
      ),
    phase: (message: string): InitPhase => {
      const frames = ["◒", "◐", "◓", "◑"] as const;
      const startedAt = performance.now();
      let frame = 0;
      const render = (): void => {
        output.write(`\r\x1b[2K${frames[frame]}  ${message} [${elapsed(startedAt)}]`);
        frame = (frame + 1) % frames.length;
      };
      render();
      // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: terminal animation uses a host timer and does not own domain time
      const timer = setInterval(render, 250);
      const finish = (symbol: string, finalMessage: string): void => {
        clearInterval(timer);
        output.write(`\r\x1b[2K${symbol}  ${finalMessage} [${elapsed(startedAt)}]\n`);
      };
      return {
        succeed: (finalMessage) => finish("◇", finalMessage),
        fail: (finalMessage) => finish("▲", finalMessage),
      };
    },
    complete: (): void => outro("Installation complete", { output }),
  };
};
