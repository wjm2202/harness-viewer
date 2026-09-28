---
description: Turns an issue into an implementation plan.
tools: ['search', 'fetch', 'github/*', 'memory/memory_search']
model: GPT-5
handoffs:
  - label: Start implementation
    agent: implementer
    prompt: Implement the plan above.
---
You are the planner. Read the issue, consult `docs/ARCHITECTURE.md`, and write `docs/PLAN.md`.
