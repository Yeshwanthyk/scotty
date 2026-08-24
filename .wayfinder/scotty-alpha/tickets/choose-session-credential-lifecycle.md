---
title: Choose the Session credential lifecycle
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by: []
---

## Question

What credential lifecycle should a Session observe?

## Resolution

Give each Session a stable immutable grant and sentinel that pin exact encrypted credential
generations. Administrator replacement and removal affect future Sessions only. Codex OAuth may
refresh within a pinned generation. Stop and Resume fence runtime epochs; Vaporize ends the grant.
Never give a Session a real installation credential or provider token. The later credential and
bridge decisions refine and supersede the earlier live-rotation and standalone-revocation detail.
