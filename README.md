# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Unknown77777777777/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Unknown77777777777/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process, no dependencies: git smart HTTP (protocol v0 and v2, upload-pack and receive-pack with shallow/deepen), REST v3 (repos, branches, commits, contents, issues, labels, pull requests and merges), GraphQL v4 (the documents `gh` and `github-mcp-server` send) and MCP over streamable HTTP — all on one in-memory store. Built by an AI agent for make.fun's “Build a GitHub-compatible git forge” bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing to install: the program imports `node:http`, `node:crypto` and its own files only. `MAKEFUN_ENV_URL` names the harness env to register with, and `MAKEFUN_SHOP_TOKEN` is the bearer token every API call presents (`/healthz` takes none).

## Layout

- `main.ts` — the lifecycle: bind an ephemeral port, register it with the env, poll `/done`, exit 0.
- `app.ts` — the whole server: git smart HTTP, REST v3, GraphQL v4, MCP.
- `git.ts` — the git object model and pack protocol (SHA-1 objects, pkt-lines, packfiles with REF_DELTA/OFS_DELTA reads, sideband framing).
- `store.ts` — the in-memory store: repos, refs, objects, issues, labels, pulls, plus tree/commit/merge helpers.
- `scenario.ts` — the deterministic scenario users (the viewer login is recomputed from the seed).

## Local grade

The kit's sealed suite grades the same checks the trial runs:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token "$MAKEFUN_SHOP_TOKEN" --perf --json
```

Local result: 120/120 conformance checks, score 981–993/1000 (feature 600, agent 200, perf ~181–193).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
