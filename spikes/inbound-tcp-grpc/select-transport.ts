#!/usr/bin/env bun

import {
  selectTransport,
  unavailableGrpcCapability,
  unavailableTcpCapability,
  type GrpcCapability,
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

const currentInput: TransportSelectionInput = {
  client: "tui",
  operation: "observe-console",
  grpc: unavailableGrpcCapability(),
  tcp: unavailableTcpCapability(),
  session: { status: "warm", operationActive: false },
};

const scenarios: Readonly<Record<string, TransportSelectionInput>> = {
  current: currentInput,
  "grpc-canary": {
    ...currentInput,
    client: "desktop",
    operation: "send-command",
    grpc: eligibleGrpc(),
  },
  "tcp-blocked": {
    ...currentInput,
    client: "terminal",
    operation: "tcp-canary-probe",
    tcp: { ...eligibleTcp(), workerGateway: false },
  },
  "tcp-canary": {
    ...currentInput,
    client: "terminal",
    operation: "tcp-canary-probe",
    tcp: eligibleTcp(),
  },
};

const scenarioName = process.argv[2] ?? "current";
const scenario = scenarios[scenarioName];

if (scenario === undefined) {
  console.error(`Unknown scenario: ${scenarioName}`);
  console.error(`Choose one of: ${Object.keys(scenarios).join(", ")}`);
  process.exitCode = 2;
} else {
  console.log(
    JSON.stringify(
      { scenario: scenarioName, input: scenario, decision: selectTransport(scenario) },
      null,
      2,
    ),
  );
}
