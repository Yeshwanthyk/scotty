export const CURRENT_WEB_TRANSPORT = "http-snapshot-sse-post" as const;

export type ClientKind = "browser" | "terminal" | "tui" | "desktop" | "runner";
export type OperationKind =
  | "observe-console"
  | "send-command"
  | "lifecycle"
  | "runner-link"
  | "direct-pi-rpc"
  | "raw-pty"
  | "tcp-canary-probe";
export type Availability = "unavailable" | "private-beta" | "public";
export type TransportRoute =
  | typeof CURRENT_WEB_TRANSPORT
  | "native-grpc"
  | "runner-websocket"
  | "tcp-worker-canary"
  | "rejected";

export interface GrpcCapability {
  readonly availability: Availability;
  readonly accountEnabled: boolean;
  readonly contractVerified: boolean;
  readonly endpointConfigured: boolean;
  readonly tls: boolean;
  readonly unary: boolean;
  readonly serverStreaming: boolean;
  readonly authenticationMetadata: boolean;
  readonly sessionDoAuthorization: boolean;
  readonly sessionRevisionFence: boolean;
  readonly epochSequenceResume: boolean;
  readonly commandIdempotency: boolean;
  readonly cancellation: boolean;
}

export interface TcpCapability {
  readonly availability: Availability;
  readonly accountEnabled: boolean;
  readonly contractVerified: boolean;
  readonly spectrumConfigured: boolean;
  readonly tls: boolean;
  readonly workerGateway: boolean;
  readonly sessionBoundCapability: boolean;
  readonly sessionDoAuthorization: boolean;
  readonly sessionRevisionFence: boolean;
  readonly epochSequenceResume: boolean;
  readonly noCredentialRelay: boolean;
  readonly explicitCanaryOptIn: boolean;
}

export interface SessionStateHint {
  readonly status: "cold" | "creating" | "warm" | "archived" | "failed";
  readonly operationActive: boolean;
}

export interface TransportSelectionInput {
  readonly client: ClientKind;
  readonly operation: OperationKind;
  readonly grpc: GrpcCapability;
  readonly tcp: TcpCapability;
  readonly session: SessionStateHint;
}

export interface TransportDecision {
  readonly route: TransportRoute;
  readonly accepted: boolean;
  readonly reason: string;
  readonly missingRequirements: readonly string[];
  readonly fallback: typeof CURRENT_WEB_TRANSPORT | null;
  readonly authority: "sandbox-durable-object";
  readonly gateway: "worker-session-do" | "runner-do" | null;
  readonly requiredFences: readonly string[];
}

const COMMON_FENCES = [
  "authenticate-client",
  "authorize-against-session-do",
  "bind-session-id",
  "bind-session-revision",
  "preserve-credential-isolation",
] as const;

const RESUMABLE_CONSOLE_FENCES = [
  ...COMMON_FENCES,
  "bind-epoch-and-sequence",
  "deduplicate-command-id",
] as const;

export const unavailableGrpcCapability = (): GrpcCapability => ({
  availability: "unavailable",
  accountEnabled: false,
  contractVerified: false,
  endpointConfigured: false,
  tls: false,
  unary: false,
  serverStreaming: false,
  authenticationMetadata: false,
  sessionDoAuthorization: false,
  sessionRevisionFence: false,
  epochSequenceResume: false,
  commandIdempotency: false,
  cancellation: false,
});

export const unavailableTcpCapability = (): TcpCapability => ({
  availability: "unavailable",
  accountEnabled: false,
  contractVerified: false,
  spectrumConfigured: false,
  tls: false,
  workerGateway: false,
  sessionBoundCapability: false,
  sessionDoAuthorization: false,
  sessionRevisionFence: false,
  epochSequenceResume: false,
  noCredentialRelay: false,
  explicitCanaryOptIn: false,
});

const missingGrpcRequirements = (capability: GrpcCapability): readonly string[] => {
  const checks = [
    [capability.availability !== "unavailable", "capability-available"],
    [capability.accountEnabled, "account-enabled"],
    [capability.contractVerified, "contract-verified"],
    [capability.endpointConfigured, "endpoint-configured"],
    [capability.tls, "tls"],
    [capability.unary, "unary"],
    [capability.serverStreaming, "server-streaming"],
    [capability.authenticationMetadata, "authentication-metadata"],
    [capability.sessionDoAuthorization, "session-do-authorization"],
    [capability.sessionRevisionFence, "session-revision-fence"],
    [capability.epochSequenceResume, "epoch-sequence-resume"],
    [capability.commandIdempotency, "command-idempotency"],
    [capability.cancellation, "cancellation"],
  ] as const;

  return checks.filter(([satisfied]) => !satisfied).map(([, name]) => name);
};

const missingTcpRequirements = (
  capability: TcpCapability,
  session: SessionStateHint,
): readonly string[] => {
  const checks = [
    [capability.availability !== "unavailable", "capability-available"],
    [capability.accountEnabled, "account-enabled"],
    [capability.contractVerified, "contract-verified"],
    [capability.spectrumConfigured, "spectrum-configured"],
    [capability.tls, "tls"],
    [capability.workerGateway, "worker-gateway"],
    [capability.sessionBoundCapability, "session-bound-capability"],
    [capability.sessionDoAuthorization, "session-do-authorization"],
    [capability.sessionRevisionFence, "session-revision-fence"],
    [capability.epochSequenceResume, "epoch-sequence-resume"],
    [capability.noCredentialRelay, "no-credential-relay"],
    [capability.explicitCanaryOptIn, "explicit-canary-opt-in"],
    [session.status === "warm", "warm-session"],
    [!session.operationActive, "no-lifecycle-operation"],
  ] as const;

  return checks.filter(([satisfied]) => !satisfied).map(([, name]) => name);
};

const webDecision = (
  reason: string,
  missingRequirements: readonly string[] = [],
): TransportDecision => ({
  route: CURRENT_WEB_TRANSPORT,
  accepted: true,
  reason,
  missingRequirements,
  fallback: null,
  authority: "sandbox-durable-object",
  gateway: "worker-session-do",
  requiredFences: RESUMABLE_CONSOLE_FENCES,
});

const rejectedDecision = (
  reason: string,
  missingRequirements: readonly string[] = [],
): TransportDecision => ({
  route: "rejected",
  accepted: false,
  reason,
  missingRequirements,
  fallback: CURRENT_WEB_TRANSPORT,
  authority: "sandbox-durable-object",
  gateway: null,
  requiredFences: RESUMABLE_CONSOLE_FENCES,
});

export const selectTransport = (input: TransportSelectionInput): TransportDecision => {
  if (input.operation === "direct-pi-rpc") {
    return rejectedDecision("pi-rpc-remains-loopback-only");
  }

  if (input.operation === "raw-pty") {
    return rejectedDecision("raw-pty-remains-unavailable");
  }

  if (input.operation === "runner-link") {
    if (input.client !== "runner") {
      return rejectedDecision("runner-link-client-mismatch");
    }

    return {
      route: "runner-websocket",
      accepted: true,
      reason: "runner-keeps-outbound-hibernatable-link",
      missingRequirements: [],
      fallback: null,
      authority: "sandbox-durable-object",
      gateway: "runner-do",
      requiredFences: COMMON_FENCES,
    };
  }

  if (input.client === "runner") {
    return rejectedDecision("runner-client-operation-mismatch");
  }

  if (input.operation === "tcp-canary-probe") {
    if (input.client !== "terminal") {
      return rejectedDecision("raw-tcp-is-not-a-client-transport");
    }

    const missingRequirements = missingTcpRequirements(input.tcp, input.session);
    if (missingRequirements.length > 0) {
      return rejectedDecision("raw-tcp-canary-gates-not-met", missingRequirements);
    }

    return {
      route: "tcp-worker-canary",
      accepted: true,
      reason: "isolated-worker-gateway-canary-only",
      missingRequirements: [],
      fallback: CURRENT_WEB_TRANSPORT,
      authority: "sandbox-durable-object",
      gateway: "worker-session-do",
      requiredFences: RESUMABLE_CONSOLE_FENCES,
    };
  }

  if (input.client === "browser") {
    return webDecision("browser-remains-web-compatible");
  }

  const missingRequirements = missingGrpcRequirements(input.grpc);
  if (missingRequirements.length > 0) {
    return webDecision("grpc-gates-not-met-use-current-transport", missingRequirements);
  }

  return {
    route: "native-grpc",
    accepted: true,
    reason: "native-client-grpc-gates-met",
    missingRequirements: [],
    fallback: CURRENT_WEB_TRANSPORT,
    authority: "sandbox-durable-object",
    gateway: "worker-session-do",
    requiredFences: RESUMABLE_CONSOLE_FENCES,
  };
};
