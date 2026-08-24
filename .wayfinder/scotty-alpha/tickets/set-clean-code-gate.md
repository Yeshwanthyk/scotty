---
title: Set the clean-code gate
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by: []
---

## Question

How should implementation handle Legacy, V2Schema, V3Schema, migration unions, and replaced mechanisms?

## Resolution

Use one canonical schema and one canonical mechanism. A clean break is allowed because the state is not shipped. At every implementation stage, check for and remove the old schema, migration union, compatibility branch, dead route, and alternate mechanism that the new code replaces. Do not leave cleanup for a later general pass.

## Refined slice gate

Each agent-owned pull request must introduce one canonical contract, move every in-scope caller,
prove it, and delete the replaced path and tests before merge. Temporary adapters may exist only
on an unmerged working branch. After all slices pass, one guarded repository-only reset clears the
unshipped Scotty-owned development state before a fresh canonical deployment.
