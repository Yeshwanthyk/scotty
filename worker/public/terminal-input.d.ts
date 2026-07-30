export function composerText(value: unknown): string | undefined;

export function hasAvailableRuntime(
  projection:
    | {
        readonly state?: unknown;
        readonly capabilities?: {
          readonly models?: ReadonlyArray<unknown>;
          readonly thinkingLevels?: ReadonlyArray<unknown>;
        };
      }
    | undefined,
): boolean;
