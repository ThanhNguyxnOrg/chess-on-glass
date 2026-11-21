# Contributing to ChessOnGlass

Thanks for your interest in contributing to **ChessOnGlass**!

## Prerequisites

- **Node.js 24 LTS** or newer
- **npm** (included with Node.js)

## Local Setup

```sh
npm ci
npm run build
npm run test:unit
```

## Architecture Rules

ChessOnGlass enforces a strict dependency hierarchy across its workspaces:

```text
app ──► game ──► perception ──► chess ──► contracts
 │       │
 └───────┴──► platform ──► contracts
```

- `chess` never imports `perception` or `game`.
- `perception` never imports `game`.
- `platform` only imports `contracts`.
- `GameCoordinator` is the single writer for live game state; async work must carry `RequestContext` and reject stale results.
- Child processes must always use `shell: false` and explicit argument arrays.
- API keys and tokens must never be logged, echoed in HTTP responses, or written to plaintext files.

## Pull Request Checklist

Before opening a pull request, make sure all checks pass:

```sh
npm run typecheck
npm --workspace=@chessonglass/ui run typecheck
npm run build
npm run check:brand
npm run test:unit
```
