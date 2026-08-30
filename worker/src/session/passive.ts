import {
  commandIntentDigest,
  PI_CONSOLE_MAX_RESPONSE_BYTES,
  PI_CONSOLE_PROXY_PREFIX,
  PiConsoleCommandErrorSchema,
  PiConsoleCommandReceiptSchema,
  PiConsoleSnapshotSchema,
  PiConsoleStaleCommandSchema,
  PiConsoleUnavailableSchema,
  type PiConsoleCommand,
} from "../../../protocol/pi-console";
import { Option, Result, Schema } from "effect";
import { readBoundedJson } from "../shared/bounded-http";
import { ScottyError } from "./contracts";

const strictProtocolDecoderOptions = { onExcessProperty: "error" } as const;
const decodeSnapshot = Schema.decodeUnknownOption(
  PiConsoleSnapshotSchema,
  strictProtocolDecoderOptions,
);
const decodeReceipt = Schema.decodeUnknownOption(
  PiConsoleCommandReceiptSchema,
  strictProtocolDecoderOptions,
);
const decodeCommandError = Schema.decodeUnknownOption(
  PiConsoleCommandErrorSchema,
  strictProtocolDecoderOptions,
);
const decodeStale = Schema.decodeUnknownOption(
  PiConsoleStaleCommandSchema,
  strictProtocolDecoderOptions,
);
const decodeUnavailable = Schema.decodeUnknownOption(
  PiConsoleUnavailableSchema,
  strictProtocolDecoderOptions,
);

export interface PassiveSessionTarget {
  readonly fetch: (request: Request) => Promise<Response>;
}

export function scottyErrorResponse(failure: ScottyError): Response {
  const { code, hint, httpStatus, message } = failure;
  return Response.json(
    {
      error: {
        code,
        message,
        ...(hint === undefined ? {} : { hint }),
      },
    },
    {
      status: httpStatus,
      headers: { "cache-control": "no-store" },
    },
  );
}

const unavailableSteer = (id: string, reason = "provider_passive_relay_unavailable") =>
  Response.json(
    { id, status: "unavailable" as const, reason, retryable: false as const },
    { headers: { "cache-control": "no-store" } },
  );

export async function inspectPassiveSession(target: PassiveSessionTarget): Promise<Response> {
  const responseResult = await Promise.resolve()
    .then(() =>
      target.fetch(
        new Request(`http://localhost${PI_CONSOLE_PROXY_PREFIX}/snapshot`, {
          headers: { accept: "application/json" },
        }),
      ),
    )
    .then(Result.succeed, () => Result.fail(undefined));
  if (Result.isFailure(responseResult))
    return scottyErrorResponse(
      new ScottyError("upstream", "Pi snapshot is unavailable", {
        httpStatus: 502,
        exitCode: 1,
        hint: "Retry after the warm session's Pi supervisor is available.",
      }),
    );
  const response = responseResult.success;
  const body = await readBoundedJson(response, PI_CONSOLE_MAX_RESPONSE_BYTES);
  if (response.status === 200 && Option.isSome(body)) {
    const snapshot = decodeSnapshot(body.value);
    if (Option.isSome(snapshot))
      return Response.json(snapshot.value, { headers: { "cache-control": "no-store" } });
  }
  if (response.status === 409)
    return scottyErrorResponse(
      new ScottyError("wrong_state", "Session is not available for inspection", {
        httpStatus: 409,
        exitCode: 5,
        hint: "The session must be warm with no active lifecycle operation.",
      }),
    );
  return scottyErrorResponse(
    new ScottyError("upstream", "Pi snapshot is unavailable", {
      httpStatus: 502,
      exitCode: 1,
      hint: "Retry after the warm session's Pi supervisor is available.",
    }),
  );
}

export async function steerPassiveSession(
  target: PassiveSessionTarget,
  id: string,
  message: string,
): Promise<Response> {
  const snapshotResult = await Promise.resolve()
    .then(() =>
      target.fetch(
        new Request(`http://localhost${PI_CONSOLE_PROXY_PREFIX}/snapshot`, {
          headers: { accept: "application/json" },
        }),
      ),
    )
    .then(Result.succeed, () => Result.fail(undefined));
  if (Result.isFailure(snapshotResult)) return unavailableSteer(id);

  const snapshotBody = await readBoundedJson(snapshotResult.success, PI_CONSOLE_MAX_RESPONSE_BYTES);
  const unavailableSnapshot = Option.isSome(snapshotBody)
    ? decodeUnavailable(snapshotBody.value)
    : Option.none();
  if (snapshotResult.success.status !== 200) {
    if (Option.isSome(unavailableSnapshot))
      return Response.json(
        {
          id,
          status: unavailableSnapshot.value.status,
          reason: unavailableSnapshot.value.reason,
          retryable: unavailableSnapshot.value.retryable,
        },
        { headers: { "cache-control": "no-store" } },
      );
    return unavailableSteer(id);
  }
  const snapshot = Option.isSome(snapshotBody) ? decodeSnapshot(snapshotBody.value) : Option.none();
  if (Option.isNone(snapshot)) return unavailableSteer(id);

  const commandId = crypto.randomUUID();
  const intent = { type: "prompt" as const, message, streamingBehavior: "steer" as const };
  const command = {
    epoch: snapshot.value.epoch,
    commandId,
    expectedSessionRevision: snapshot.value.sessionRevision,
    intent,
  } satisfies PiConsoleCommand;
  const commandResult = await Promise.resolve()
    .then(() =>
      target.fetch(
        new Request(`http://localhost${PI_CONSOLE_PROXY_PREFIX}/command`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(command),
        }),
      ),
    )
    .then(Result.succeed, () => Result.fail(undefined));
  if (Result.isFailure(commandResult))
    return Response.json(
      { id, status: "ambiguous" as const, reason: "command_transport_failed" as const },
      { headers: { "cache-control": "no-store" } },
    );

  const commandBody = await readBoundedJson(commandResult.success, PI_CONSOLE_MAX_RESPONSE_BYTES);
  if (Option.isNone(commandBody))
    return Response.json(
      { id, status: "ambiguous" as const, reason: "command_response_invalid" as const },
      { headers: { "cache-control": "no-store" } },
    );

  const stale = decodeStale(commandBody.value);
  if (Option.isSome(stale))
    return Response.json(
      {
        id,
        status: stale.value.status,
        reason: "session_revision_changed" as const,
        expectedSessionRevision: stale.value.expectedSessionRevision,
        sessionRevision: stale.value.sessionRevision,
        retryable: stale.value.retryable,
      },
      { headers: { "cache-control": "no-store" } },
    );
  const commandError = decodeCommandError(commandBody.value);
  if (Option.isSome(commandError))
    return commandError.value.code === "scotty_epoch_changed"
      ? Response.json(
          {
            id,
            status: "stale" as const,
            reason: "epoch_changed" as const,
            expectedSessionRevision: snapshot.value.sessionRevision,
            retryable: false as const,
          },
          { headers: { "cache-control": "no-store" } },
        )
      : Response.json(
          {
            id,
            status: "unavailable" as const,
            reason: commandError.value.code,
            retryable: false as const,
          },
          { headers: { "cache-control": "no-store" } },
        );
  const unavailable = decodeUnavailable(commandBody.value);
  if (Option.isSome(unavailable))
    return Response.json(
      {
        id,
        status: unavailable.value.status,
        reason: unavailable.value.reason,
        retryable: unavailable.value.retryable,
      },
      { headers: { "cache-control": "no-store" } },
    );
  const receipt = decodeReceipt(commandBody.value);
  const expectedDigest = await commandIntentDigest(intent);
  if (
    Option.isSome(receipt) &&
    receipt.value.epoch === command.epoch &&
    receipt.value.commandId === command.commandId &&
    receipt.value.commandDigest === expectedDigest
  ) {
    if (receipt.value.status !== "rejected" && commandResult.success.ok)
      return Response.json(
        {
          id,
          status: "accepted" as const,
          commandId,
          epoch: command.epoch,
          sessionRevision: command.expectedSessionRevision,
        },
        { headers: { "cache-control": "no-store" } },
      );
    if (receipt.value.status === "rejected")
      return Response.json(
        {
          id,
          status: "unavailable" as const,
          reason: "command_rejected" as const,
          retryable: false as const,
        },
        { headers: { "cache-control": "no-store" } },
      );
  }
  return Response.json(
    { id, status: "ambiguous" as const, reason: "command_receipt_mismatch" as const },
    { headers: { "cache-control": "no-store" } },
  );
}
