import { redactCredentialSentinels } from "../../protocol/pi-console-shared.mjs";

const MAX_STRING_LENGTH = 16 * 1024;
const MAX_DEPTH = 12;
const MAX_ARRAY_ITEMS = 500;
const MAX_OBJECT_KEYS = 100;

export const truncateRemoteString = (value: string, maxLength: number): string => {
  let end = Math.min(value.length, maxLength);
  if (
    end > 0 &&
    end < value.length &&
    /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/u.test(value[end] ?? "")
  )
    end -= 1;
  return value.slice(0, end);
};

export const redactRemoteString = (value: string): string =>
  truncateRemoteString(
    redactCredentialSentinels(
      value
        // Terminal output is styled only after remote content is stripped.
        // oxlint-disable-next-line eslint/no-control-regex -- intentional OSC removal
        .replaceAll(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
        // oxlint-disable-next-line eslint/no-control-regex -- intentional ANSI removal
        .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, ""),
    )
      .replaceAll(/(?:ghp_|github_pat_)[A-Za-z0-9_]+/gu, "[credential]")
      .replaceAll(/scotty_(?:client|pair|recovery|transfer)\.[A-Za-z0-9._-]+/gu, "[credential]")
      // Include C1 controls: their 8-bit CSI/OSC forms can also mutate terminal state.
      // oxlint-disable-next-line eslint/no-control-regex -- remote controls are never retained
      .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ""),
    MAX_STRING_LENGTH,
  );

export const redactRemoteLine = (value: string): string =>
  redactRemoteString(value).replaceAll(/[\t\r\n]+/gu, " ");

export const redactRemoteValue = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactRemoteString(value);
  if (Array.isArray(value))
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactRemoteValue(item, depth + 1));
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_OBJECT_KEYS)
        .map(([key, item]) => [redactRemoteString(key), redactRemoteValue(item, depth + 1)]),
    );
  return null;
};

export const formatRemoteValue = (value: unknown, maxLength = 2_000): string => {
  if (typeof value === "string") return truncateRemoteString(redactRemoteString(value), maxLength);
  const rendered = JSON.stringify(redactRemoteValue(value));
  return truncateRemoteString(rendered ?? "null", maxLength);
};
