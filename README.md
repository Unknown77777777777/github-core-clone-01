# github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Unknown77777777777/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Unknown77777777777/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in TypeScript (Node 22, standard
library only, no dependencies, no install step, no git binary, no network
beyond the test suite).

One process serves:

- **REST v3** (`/api/v3`): repositories, contents, labels, issues, pull
  requests, squash merge.
- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack v0 + v2
  (ls-refs, fetch, shallow), receive-pack v0 with fast-forward enforcement,
  packfile reading/writing, SHA-1 objects (blobs, trees, commits) via zlib.
- **GraphQL v4** (`/api/graphql`): repository / issue / pull-request queries,
  `createPullRequest`, introspection, batched operation documents.
- **MCP** (`POST /mcp`): JSON-RPC 2.0 Streamable HTTP, protocol revisions
  2026-07-28 and earlier handshakes, eight tools acting on the same store
  as REST.

## Run

```sh
node main.ts
```

The program binds an ephemeral port, registers it at
`$MAKEFUN_ENV_URL/register`, serves the suite, and exits when
`GET $MAKEFUN_ENV_URL/done` answers `{"done": true}`.

All state is in memory and deterministic: ids and timestamps come from
counters (seeded only by `MAKEFUN_TRIAL_NOW` when set), so a replay leaves
the same state.

[make.fun](https://make.fun)
