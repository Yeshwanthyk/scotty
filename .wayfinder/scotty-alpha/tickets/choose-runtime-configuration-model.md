---
title: Choose the runtime and configuration model
status: closed
label: wayfinder:grilling
mode: HITL
assignee: yesh
blocked_by: []
---

## Question

What configuration and customization model should the alpha expose?

## Resolution

Use Pi as the core runtime. Keep one private local installation config and one validated deployed snapshot. Do not add profiles. Each installation has one Sandbox setup. New Sessions receive the latest setup, while existing Sessions keep the setup with which they started. Only the installation administrator manages Plugins. Each Plugin has one declared type, such as compute provider, Pi extension, Skill, or tool.
