---
title: Choose Publish and repository cleanup
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by: []
---

## Question

When should Session work return to GitHub, and when should Scotty remove the Session repository?

## Resolution

Publish only when the requested task includes publishing or opening a pull request. Run the required checks first. Then push a controlled GitHub branch and create or update its pull request. Keep the Artifacts Fork through Sleep, Snapshot, and Resume. Delete it during successful Vaporize cleanup. Keep R2 backups because Git does not preserve all Session state or uncommitted work.
