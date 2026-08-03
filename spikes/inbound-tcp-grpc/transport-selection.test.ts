import { describe, expect, it } from "vitest";
import {
  CURRENT_WEB_TRANSPORT,
  selectTransport,
  unavailableGrpcCapability,
  unavailableTcpCapability,
  type ClientKind,
  type GrpcCapability,
  type OperationKind,
  type TcpCapability,
  type TransportSelectionInput,
} from "./transport-selection.ts";

const eligibleGrpc = (): GrpcCapability => ({
  availability: "private-beta",
  accountEnabled: true,
  contractVerified: true,
  endpointConfigured: true,
  tls: true,
  unary: true,
  serverStreaming: true,
  authenticationMetadata: true,
  sessionDoAuthorization: true,
  sessionRevisionFence: true,
  epochSequenceResume: true,
  commandIdempotency: true,
  cancellation: true,
});

const eligibleTcp = (): TcpCapability => ({
  availability: "private-beta",
  accountEnabled: true,
  contractVerified: true,
  spectrumConfigured: true,
  tls: true,
  workerGateway: true,
  sessionBoundCapability: true,
  sessionDoAuthorization: true,
  sessionRevisionFence: true,
  epochSequenceResume: true,
  noCredentialRelay: true,
  explicitCanaryOptIn: true,
});

const input = (
  client: ClientKind,
  operation: OperationKind,
  overrides: Partial<TransportSelectionInput> = {},
): TransportSelectionInput => ({
  client,
  operation,
  grpc: unavailableGrpcCapability(),
  tcp: unavailableTcpCapability(),
  session: { status: "warm", operationActive: false },
  ...overrides,
});

describe("transport selection", () => {
  it("keeps the browser console on the current web-compatible transport", () => {
    const decision = selectTransport(
      input("browser", "observe-console", {
        grpc: eligibleGrpc(),
        tcp: eligibleTcp(),
      }),
    );

    expect(decision).toMatchObject({
      route: CURRENT_WEB_TRANSPORT,
      accepted: true,
      reason: "browser-remains-web-compatible",
      authority: "sandbox-durable-object",
    });
  });

  it.each([
    ["terminal", "observe-console"],
    ["tui", "send-command"],
    ["desktop", "lifecycle"],
  ] as const)("lets an eligible %s client prefer gRPC for %s", (client, operation) => {
    const decision = selectTransport(input(client, operation, { grpc: eligibleGrpc() }));

    expect(decision).toMatchObject({
      route: "native-grpc",
      accepted: true,
      fallback: CURRENT_WEB_TRANSPORT,
      authority: "sandbox-durable-object",
      gateway: "worker-session-do",
    });
    expect(decision.requiredFences).toContain("bind-session-revision");
    expect(decision.requiredFences).toContain("bind-epoch-and-sequence");
  });

  it.each([
    [
      "unavailable beta",
      (): GrpcCapability => ({ ...eligibleGrpc(), availability: "unavailable" }),
    ],
    ["account enrollment", (): GrpcCapability => ({ ...eligibleGrpc(), accountEnabled: false })],
    ["verified contract", (): GrpcCapability => ({ ...eligibleGrpc(), contractVerified: false })],
    [
      "authentication metadata",
      (): GrpcCapability => ({ ...eligibleGrpc(), authenticationMetadata: false }),
    ],
    [
      "DO authorization",
      (): GrpcCapability => ({ ...eligibleGrpc(), sessionDoAuthorization: false }),
    ],
    [
      "revision fencing",
      (): GrpcCapability => ({ ...eligibleGrpc(), sessionRevisionFence: false }),
    ],
    ["resume cursor", (): GrpcCapability => ({ ...eligibleGrpc(), epochSequenceResume: false })],
    [
      "command idempotency",
      (): GrpcCapability => ({ ...eligibleGrpc(), commandIdempotency: false }),
    ],
    ["cancellation", (): GrpcCapability => ({ ...eligibleGrpc(), cancellation: false })],
  ] as const)("falls back to HTTP/SSE when gRPC lacks %s", (_name, capability) => {
    const decision = selectTransport(input("tui", "observe-console", { grpc: capability() }));

    expect(decision.route).toBe(CURRENT_WEB_TRANSPORT);
    expect(decision.reason).toBe("grpc-gates-not-met-use-current-transport");
    expect(decision.missingRequirements).not.toHaveLength(0);
  });

  it("keeps the runner on its outbound WebSocket multiplex", () => {
    const decision = selectTransport(
      input("runner", "runner-link", {
        grpc: eligibleGrpc(),
        tcp: eligibleTcp(),
      }),
    );

    expect(decision).toMatchObject({
      route: "runner-websocket",
      accepted: true,
      gateway: "runner-do",
      reason: "runner-keeps-outbound-hibernatable-link",
    });
  });

  it("rejects runner-link use by a native console client", () => {
    const decision = selectTransport(input("tui", "runner-link"));

    expect(decision).toMatchObject({
      route: "rejected",
      accepted: false,
      reason: "runner-link-client-mismatch",
    });
  });

  it("rejects console operations presented as a runner", () => {
    const decision = selectTransport(input("runner", "send-command"));

    expect(decision).toMatchObject({
      route: "rejected",
      accepted: false,
      reason: "runner-client-operation-mismatch",
    });
  });

  it("keeps Pi RPC loopback-only", () => {
    const decision = selectTransport(input("desktop", "direct-pi-rpc", { grpc: eligibleGrpc() }));

    expect(decision).toMatchObject({
      route: "rejected",
      accepted: false,
      fallback: CURRENT_WEB_TRANSPORT,
      reason: "pi-rpc-remains-loopback-only",
    });
  });

  it("rejects raw TCP when it would terminate at a Container instead of the Worker gateway", () => {
    const decision = selectTransport(
      input("terminal", "tcp-canary-probe", {
        tcp: { ...eligibleTcp(), workerGateway: false },
      }),
    );

    expect(decision).toMatchObject({
      route: "rejected",
      accepted: false,
      fallback: CURRENT_WEB_TRANSPORT,
    });
    expect(decision.missingRequirements).toContain("worker-gateway");
  });

  it.each([
    ["cold session", { status: "cold", operationActive: false }],
    ["active lifecycle operation", { status: "warm", operationActive: true }],
  ] as const)("rejects a raw TCP canary for a %s", (_name, session) => {
    const decision = selectTransport(
      input("terminal", "tcp-canary-probe", { tcp: eligibleTcp(), session }),
    );

    expect(decision.route).toBe("rejected");
    expect(decision.accepted).toBe(false);
  });

  it("allows only an explicitly gated Worker TCP canary", () => {
    const decision = selectTransport(input("terminal", "tcp-canary-probe", { tcp: eligibleTcp() }));

    expect(decision).toMatchObject({
      route: "tcp-worker-canary",
      accepted: true,
      fallback: CURRENT_WEB_TRANSPORT,
      authority: "sandbox-durable-object",
      gateway: "worker-session-do",
      reason: "isolated-worker-gateway-canary-only",
    });
    expect(decision.requiredFences).toContain("preserve-credential-isolation");
  });

  it("never exposes a raw PTY even when every TCP canary gate is met", () => {
    const terminal = selectTransport(input("terminal", "raw-pty", { tcp: eligibleTcp() }));

    expect(terminal).toMatchObject({
      route: "rejected",
      accepted: false,
      reason: "raw-pty-remains-unavailable",
    });
  });

  it("never offers the TCP canary protocol to the TUI or desktop", () => {
    const tui = selectTransport(input("tui", "tcp-canary-probe", { tcp: eligibleTcp() }));
    const desktop = selectTransport(input("desktop", "tcp-canary-probe", { tcp: eligibleTcp() }));

    expect([tui.route, desktop.route]).toEqual(["rejected", "rejected"]);
  });
});
