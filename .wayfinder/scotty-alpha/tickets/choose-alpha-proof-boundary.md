---
title: Choose the alpha proof boundary
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by: []
---

## Question

Which proof belongs at the final alpha gate, and which proof must run more often?

## Resolution

Use the complete Sandbox, browser, TUI, Hatch, screenshot, and Summary walkthrough to prove the current end result. Do not require the complete walkthrough for every canary. The user will manually test the TUI until it is packaged in the single Scotty executable. The exact smaller check sets remain to be decided.

## Refined proof levels

Each agent pull request runs focused deterministic proof. Integration runs the full local baseline.
Cloudflare implementation and its complete deployed canary finish first. Trusted Runner production
implementation starts after that proof and its deployed canary runs as the final provider phase.
The exact release candidate then runs one automated complete walkthrough plus human acceptance.
