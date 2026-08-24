---
title: Choose the alpha compute scope
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by: []
---

## Question

Which compute providers must the alpha support?

## Resolution

Support Cloudflare and trusted runners. A Session must explicitly select a compute provider and, for runner compute, a named runner. Both providers must satisfy the same core Session lifecycle. Leave Modal, Daytona, and other providers for later Plugins.

## Refined Runner availability

A trusted Runner is in alpha scope only as a certified provider route. Registration and an
authenticated connection are not enough. Runner-backed Session creation stays disabled until the
full deployed parity canary proves the canonical lifecycle, brokers, repository work, checkpoints,
Hatch, capture, and cleanup for that release.

## Refined implementation order

Shared contracts and the complete Cloudflare product path are implemented and proven first.
Trusted Runner production implementation begins only after the Cloudflare canary passes. Runner
proof is the final provider phase, and both providers still block the first alpha release.
