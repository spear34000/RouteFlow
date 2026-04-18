# Contributing to RouteFlow

Thanks for helping improve RouteFlow.

## Before you start

- Read the top-level [README.md](./README.md)
- Use the docs in [`docs/`](./docs/README.md) for user-facing behavior
- Keep the product message aligned with `AGENTS.md`

## Local setup

```bash
pnpm install
```

Run the core package tests:

```bash
pnpm --filter routeflow-api test
pnpm --filter routeflow-api build
```

Useful repo-level checks:

```bash
pnpm run example:differentiation:smoke
pnpm run test:e2e
```

## Pull request expectations

- Keep changes scoped and explain the user-facing impact
- Add or update tests for behavior changes
- Update docs when public APIs or defaults change
- Do not mix internal work notes into `docs/`

## Commit and review tips

- Prefer small commits that are easy to review
- Call out breaking changes clearly
- Link the relevant issue when available

## Reporting bugs

Use the bug report template when possible and include:

- RouteFlow version
- Node.js version
- Transport (`websocket` or `sse`)
- Adapter/store details
- A minimal reproduction

## Feature proposals

Use the feature request template and describe:

- The problem you are trying to solve
- The API shape you want
- Trade-offs or alternatives you considered
