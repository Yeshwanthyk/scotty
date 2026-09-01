import { Writable } from "node:stream";
import { intro, note, outro } from "@clack/prompts";
import type { Writer } from "./core";
import type { InstallationPlanChange } from "./services";

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

export interface UiPhase {
  readonly succeed: (message: string) => void;
  readonly fail: (message: string) => void;
}

export interface InitUi {
  readonly start: () => void;
  readonly review: (review: InitReview) => void;
  readonly phase: (message: string) => UiPhase;
  readonly complete: () => void;
}

export interface DeployPlanReview {
  readonly fingerprint: string;
  readonly bundleDigest: string;
  readonly changes: ReadonlyArray<InstallationPlanChange>;
}

export interface DeployUi {
  readonly start: () => void;
  readonly phase: (message: string) => UiPhase;
  readonly review: (review: DeployPlanReview) => void;
  readonly planComplete: (plannedChanges: number) => void;
  readonly applyComplete: (plannedChanges: number, providerOperations: number) => void;
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

const phase = (output: Writable, message: string): UiPhase => {
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
};

const count = (value: number, singular: string, plural: string): string =>
  `${value} ${value === 1 ? singular : plural}`;

const deployPlanLines = (review: DeployPlanReview): string =>
  [
    `Plan fingerprint  ${review.fingerprint}`,
    `Bundle digest     ${review.bundleDigest}`,
    `Planned changes   ${review.changes.length}`,
    "",
    ...(review.changes.length === 0
      ? ["No provider resource changes."]
      : review.changes.map((change) => `${change.action.padEnd(14)} ${change.id}`)),
    "",
    "Apply command     scotty deploy --yes",
  ].join("\n");

export const makeSilentInitUi = (): InitUi => ({
  start: () => undefined,
  review: () => undefined,
  phase: () => ({ succeed: () => undefined, fail: () => undefined }),
  complete: () => undefined,
});

export const makeSilentDeployUi = (): DeployUi => ({
  start: () => undefined,
  phase: () => ({ succeed: () => undefined, fail: () => undefined }),
  review: () => undefined,
  planComplete: () => undefined,
  applyComplete: () => undefined,
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
    phase: (message: string): UiPhase => phase(output, message),
    complete: (): void => outro("Installation complete", { output }),
  };
};

export const makeDeployUi = (writer: Writer): DeployUi => {
  const output = writerStream(writer);
  return {
    start: (): void => intro("Scotty deploy", { output }),
    phase: (message: string): UiPhase => phase(output, message),
    review: (review): void => note(deployPlanLines(review), "Exact deployment plan", { output }),
    planComplete: (plannedChanges): void =>
      outro(`Plan saved · ${count(plannedChanges, "planned change", "planned changes")}`, {
        output,
      }),
    applyComplete: (plannedChanges, providerOperations): void =>
      outro(
        `Deployment ready · ${count(plannedChanges, "planned change", "planned changes")} · ${count(providerOperations, "provider operation succeeded", "provider operations succeeded")} · root credentials unchanged`,
        { output },
      ),
  };
};
