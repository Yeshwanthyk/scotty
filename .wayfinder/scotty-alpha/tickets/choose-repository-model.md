---
title: Choose the repository model
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by: []
---

## Question

Where should source authority live, and how should Scotty isolate repository work between Sessions?

## Resolution

Keep GitHub as the source of record. Maintain a one-way Cloudflare Artifacts Mirror from GitHub. Create one isolated Artifacts Fork for each Session. Use the same repository flow on Cloudflare and trusted runners. Make Cloudflare Artifacts a required alpha dependency.
