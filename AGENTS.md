# Agent instructions

`@doubleagent-so/observe`: records what an AI agent does (A2A, MCP or a custom protocol) and sends it to Double
Agent. Public, MIT. Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing what the recorder sends.

## Commands

```sh
npm ci
npm test                # vitest
npm run test:coverage   # ≥ 90% lines and branches on src/
npm run typecheck
npm run build           # dist/ (publish with `npm publish ./dist`)
```

## Rules

- Test first. Every behaviour change starts with a failing test.
- The recorder never throws into, delays or breaks the host agent. Every host-facing path has a test for that.
- Erasable TypeScript only, `.ts` extensions on relative imports. async/await, no `.then` chains.
- The event contract is the wire format the Double Agent API accepts. Changing a field is a coordinated change with
  the server; new fields are additive and optional.
- Export lists are pinned in `test/exports.test.ts`; removing an export is a major release.
- Nothing private: no internal hosts, keys or customer data. Security reports go to SECURITY.md, not issues.

## Used as a submodule

The Double Agent monorepo checks this repo out at `packages/observe` as a git submodule. When working from there,
commit and push here first (a submodule starts on a detached HEAD: `git switch main && git pull` before editing), then
bump the pointer in the monorepo. Its CI fails if the pinned commit is not on this repo's `main`.
