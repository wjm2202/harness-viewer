# Acme Harness

This repo is developed by a small team of AI agents coordinated through Copilot.

## Agents

- **planner**: breaks a request into a plan and writes `docs/PLAN.md`
- **implementer**: reads `docs/PLAN.md` and edits the code
- **reviewer**: reviews the diff against `docs/STYLE.md`

## MCP tools

- `github/create_pull_request`: opens the PR
- `memory/memory_search`: recall prior decisions

## Feature workflow

1. The @planner reads the issue and writes `docs/PLAN.md`.
2. The @implementer follows `docs/PLAN.md` and updates `src/` using `edit`.
3. Run the tests with `runTests`; if tests fail, go back to step 2.
4. The @reviewer reviews the change and records findings in `docs/REVIEW.md`.
5. Open a pull request with `github/create_pull_request`.

## Rules

- Never push directly to `main`.
- Always update `CHANGELOG.md` when behaviour changes.

See [the style guide](../docs/STYLE.md) and [agent rules](../AGENTS.md).

```bash
# 1. this is code and must be ignored
- **ghost**: not an agent
```
