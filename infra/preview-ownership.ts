import { Data, Option, Schema } from "effect";
import type { InstallationPreviewConfiguration } from "./installation.ts";

const PreviewDeletionEnvelopeSchema = Schema.Struct({
  state: Schema.Struct({ logicalId: Schema.String }),
});
const OwnedPreviewRouteDeletionSchema = Schema.Struct({
  resource: Schema.Struct({ Type: Schema.Literal("Cloudflare.Workers.Route") }),
  state: Schema.Struct({
    resourceType: Schema.Literal("Cloudflare.Workers.Route"),
    logicalId: Schema.Literal("EvidencePreviewWorkerRoute"),
    props: Schema.Struct({ zoneId: Schema.String, pattern: Schema.String, script: Schema.String }),
    attr: Schema.Struct({
      routeId: Schema.NonEmptyString,
      zoneId: Schema.String,
      pattern: Schema.String,
      script: Schema.String,
    }),
  }),
});
const OwnedPreviewDnsDeletionSchema = Schema.Struct({
  resource: Schema.Struct({ Type: Schema.Literal("Cloudflare.DNS.Record") }),
  state: Schema.Struct({
    resourceType: Schema.Literal("Cloudflare.DNS.Record"),
    logicalId: Schema.Literal("EvidencePreviewWildcardDns"),
    props: Schema.Struct({
      zoneId: Schema.String,
      name: Schema.String,
      type: Schema.Literal("AAAA"),
      content: Schema.Literal("100::"),
      proxied: Schema.Literal(true),
    }),
    attr: Schema.Struct({
      recordId: Schema.NonEmptyString,
      zoneId: Schema.String,
      name: Schema.String,
      type: Schema.Literal("AAAA"),
      content: Schema.Literal("100::"),
      proxied: Schema.Literal(true),
    }),
  }),
});
const decodePreviewDeletionEnvelope = Schema.decodeUnknownOption(PreviewDeletionEnvelopeSchema);
const decodeOwnedPreviewRouteDeletion = Schema.decodeUnknownOption(OwnedPreviewRouteDeletionSchema);
const decodeOwnedPreviewDnsDeletion = Schema.decodeUnknownOption(OwnedPreviewDnsDeletionSchema);

export class PreviewCleanupOwnershipError extends Data.TaggedError("PreviewCleanupOwnershipError")<{
  readonly message: string;
  readonly hint: string;
}> {}
export const decodePreviewCleanupOwnershipError = Schema.decodeUnknownOption(
  Schema.Struct({
    _tag: Schema.Literal("PreviewCleanupOwnershipError"),
    message: Schema.String,
    hint: Schema.String,
  }),
);

export interface OwnedPreviewTopologyDeletion {
  readonly routeId: string;
  readonly dnsRecordId: string;
}

export const readOwnedPreviewTopologyDeletion = (
  deletions: ReadonlyArray<unknown>,
  preview: InstallationPreviewConfiguration,
  workerName: string,
): OwnedPreviewTopologyDeletion | undefined => {
  const candidates = (logicalId: string) =>
    deletions.filter((deletion) => {
      const decoded = decodePreviewDeletionEnvelope(deletion);
      return Option.isSome(decoded) && decoded.value.state.logicalId === logicalId;
    });
  const routeCandidates = candidates("EvidencePreviewWorkerRoute");
  const dnsCandidates = candidates("EvidencePreviewWildcardDns");
  if (routeCandidates.length !== 1 || dnsCandidates.length !== 1) return undefined;
  const route = decodeOwnedPreviewRouteDeletion(routeCandidates[0]);
  const dns = decodeOwnedPreviewDnsDeletion(dnsCandidates[0]);
  if (Option.isNone(route) || Option.isNone(dns)) return undefined;
  const routePattern = `*.${preview.base}/*`;
  const dnsName = `*.${preview.base}`;
  if (
    route.value.state.props.zoneId !== preview.zoneId ||
    route.value.state.props.pattern !== routePattern ||
    route.value.state.props.script !== workerName ||
    route.value.state.attr.zoneId !== preview.zoneId ||
    route.value.state.attr.pattern !== routePattern ||
    route.value.state.attr.script !== workerName ||
    dns.value.state.props.zoneId !== preview.zoneId ||
    dns.value.state.props.name !== dnsName ||
    dns.value.state.attr.zoneId !== preview.zoneId ||
    dns.value.state.attr.name !== dnsName
  )
    return undefined;
  return {
    routeId: route.value.state.attr.routeId,
    dnsRecordId: dns.value.state.attr.recordId,
  };
};
