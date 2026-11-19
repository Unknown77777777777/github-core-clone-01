import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Repo, Issue, Pull } from "./store.ts";
import { Store, repoJson, issueJson, pullJson, labelJson, storeObject } from "./store.ts";
import {
  pktLine,
  pktFlush,
  pktDelim,
  readPktLines,
  parseCommit,
  parseTree,
  buildTree,
  makeCommit,
  lookupPath,
  listFiles,
  setPathInTree,
  isAncestor,
  mergeBase,
  parsePack,
  collectReachable,
  buildPack,
  refsOf,
} from "./git.ts";

let reqCounter = 0;

function sendJson(res: ServerResponse, status: number, obj: unknown, extra: Record<string, string> = {}): void {
  const body = JSON.stringify(obj);
  reqCounter += 1;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-GitHub-Request-Id": "req-" + reqCounter,
    "Content-Length": String(Buffer.byteLength(body)),
    ...extra,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendErr(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: "https://docs.github.com" });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJsonBody(buf: Buffer): { ok: boolean; value?: unknown } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString("utf8")) };
  } catch {
    return { ok: false };
  }
}

function authOk(req: IncomingMessage, token: string): boolean {
  if (!token) return true;
  const h = req.headers.authorization || "";
  return h === "Bearer " + token;
}

function splitPath(url: string): string[] {
  const p = url.split("?")[0];
  return p.split("/").filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

function queryParams(url: string): URLSearchParams {
  const q = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  return new URLSearchParams(q);
}

// ---------------- REST helpers ----------------
function headShaOf(repo: Repo, branch: string): string {
  return repo.branches.get(branch) || "";
}

function branchHead(repo: Repo): string {
  return repo.branches.get(repo.defaultBranch) || "";
}

// Create a commit on `branch` that sets `path` to `content` (or deletes it).
function commitFileChange(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): string {
  const head = headShaOf(repo, branch);
  let rootTree = "";
  const parents: string[] = [];
  if (head) {
    const obj = repo.objects.get(head);
    if (obj && obj.type === "commit") {
      rootTree = parseCommit(obj.data).tree;
      parents.push(head);
    }
  } else {
    rootTree = storeObject(repo, "tree", buildTree([]));
  }
  const newTree = setPathInTree(repo, rootTree, path, content);
  const commitSha = makeCommit(repo, newTree, parents, message || "Update file");
  repo.branches.set(branch, commitSha);
  repo.updatedAt = store.stamp();
  repo.packCache.clear();
  return commitSha;
}

export function createServerApp(store: Store, token: string) {
  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      try {
        if (!res.headersSent) sendErr(res, 500, String((e as Error)?.message || e));
        else res.end();
      } catch {
        // ignore
      }
    });
  });
  // NOTE: `return server` is at the end of this function, after all the
  // const declarations below, so they are initialized before any request
  // can be handled.

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method || "GET";
    const url = req.url || "/";
    const parts = splitPath(url);
    const qp = queryParams(url);

    // ---- git smart HTTP (no bearer required; git clients may not send it) ----
    // The .git segment sits in the middle of the path:
    // /{owner}/{repo}.git/info/refs, /{owner}/{repo}.git/git-upload-pack, ...
    if (parts.some((p) => p.endsWith(".git"))) {
      await handleGit(req, res, method, url, parts);
      return;
    }

    // ---- auth for API surfaces ----
    if (parts[0] === "api" || parts[0] === "mcp") {
      if (!authOk(req, token)) {
        sendErr(res, 401, "Requires authentication");
        return;
      }
    }

    if (parts[0] === "mcp") {
      await handleMcp(req, res, method);
      return;
    }
    if (parts[0] === "api" && parts[1] === "graphql") {
      await handleGraphql(req, res, method);
      return;
    }
    if (parts[0] === "api" && parts[1] === "v3") {
      await handleRest(req, res, method, url, parts, qp);
      return;
    }
    sendErr(res, 404, "Not Found");
  }

  // ---------------- REST ----------------
  async function handleRest(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    _url: string,
    parts: string[],
    qp: URLSearchParams,
  ): Promise<void> {
    const rest = parts.slice(2); // after api/v3
    const bodyBuf = method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE" ? await readBody(req) : Buffer.alloc(0);
    let body: unknown = {};
    if (bodyBuf.length > 0) {
      const parsed = parseJsonBody(bodyBuf);
      if (!parsed.ok) {
        sendErr(res, 400, "Problems parsing JSON");
        return;
      }
      body = parsed.value;
    }
    const b = (body || {}) as Record<string, unknown>;

    // GET /api/v3/
    if (rest.length === 0) {
      if (method !== "GET") return sendErr(res, 404, "Not Found");
      return sendJson(res, 200, {
        current_user_url: "https://api.github.com/user",
        current_user_authorizations_html_url: "https://github.com/settings/applications",
        authorizations_url: "https://api.github.com/authorizations",
        code_search_url: "https://api.github.com/search/code?q={query}",
        commit_search_url: "https://api.github.com/search/commits?q={query}",
        emails_url: "https://api.github.com/user/emails",
        emojis_url: "https://api.github.com/emojis",
        events_url: "https://api.github.com/events",
        feeds_url: "https://api.github.com/feeds",
        followers_url: "https://api.github.com/user/followers",
        following_url: "https://api.github.com/user/following{/other_user}",
        gists_url: "https://api.github.com/gists{/gist_id}",
        hub_url: "https://api.github.com/hub",
        issue_search_url: "https://api.github.com/search/issues?q={query}",
        issues_url: "https://api.github.com/issues",
        keys_url: "https://api.github.com/user/keys",
        label_search_url: "https://api.github.com/search/labels?q={query}",
        notifications_url: "https://api.github.com/notifications",
        organization_repositories_url: "https://api.github.com/orgs/{org}/repos{?type,page,per_page,sort}",
        organization_url: "https://api.github.com/orgs/{org}",
        public_gists_url: "https://api.github.com/gists/public",
        rate_limit_url: "https://api.github.com/rate_limit",
        repository_url: "https://api.github.com/repos/{owner}/{repo}",
        repository_search_url: "https://api.github.com/search/repositories?q={query}",
        current_user_repositories_url: "https://api.github.com/user/repos{?type,page,per_page,sort}",
        starred_url: "https://api.github.com/user/starred{/owner}{/repo}",
        starred_gists_url: "https://api.github.com/gists/starred",
        user_url: "https://api.github.com/users/{user}",
        user_organizations_url: "https://api.github.com/user/orgs",
        user_repositories_url: "https://api.github.com/users/{user}/repos{?type,page,per_page,sort}",
        user_search_url: "https://api.github.com/search/users?q={query}",
      }, { "X-OAuth-Scopes": "repo, user, gist", "X-Accepted-OAuth-Scopes": "repo" });
    }

    if (rest[0] === "meta" && rest.length === 1) {
      if (method !== "GET") return sendErr(res, 404, "Not Found");
      return sendJson(res, 200, {
        verifiable_password_authentication: true,
        installed_version: "1.0.0",
        ssh_key_fingerprints: {},
        hooks: [],
        web: [],
        api: [],
        git: [],
        packages: [],
        pages: [],
        importer: [],
        actions: [],
        dependabot: [],
      });
    }

    if (rest[0] === "user" && rest[1] === "repos") {
      if (method === "GET") {
        const page = Math.max(1, parseInt(qp.get("page") || "1", 10) || 1);
        const perPage = Math.min(100, Math.max(1, parseInt(qp.get("per_page") || "30", 10) || 30));
        const all = store.listRepos();
        const slice = all.slice((page - 1) * perPage, page * perPage);
        const extra: Record<string, string> = {};
        if (page * perPage < all.length) {
          extra.Link = `<https://api.github.com/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next", <https://api.github.com/user/repos?page=${Math.ceil(all.length / perPage)}&per_page=${perPage}>; rel="last"`;
        }
        return sendJson(res, 200, slice.map((r) => repoJson(store, r)), extra);
      }
      if (method === "POST") {
        const name = String(b.name || "").trim();
        if (!name) return sendErr(res, 422, "Validation Failed: name is required");
        if (store.getRepoByName(name)) return sendErr(res, 422, "Validation Failed: name already exists on this account");
        const repo = store.createRepo(name, String(b.description || ""));
        return sendJson(res, 201, repoJson(store, repo));
      }
      return sendErr(res, 404, "Not Found");
    }

    if (rest[0] === "user" && rest.length === 1 && method === "GET") {
      const login = store.tokenLogin() || "owner";
      return sendJson(res, 200, { login, id: 1, node_id: "U_1", type: "User", site_admin: false });
    }

    if (rest[0] === "repos" && rest.length >= 3) {
      const owner = rest[1];
      const repoName = rest[2];
      const tail = rest.slice(3);
      await handleRepoRest(req, res, method, owner, repoName, tail, qp, b);
      return;
    }

    if (rest[0] === "search" && method === "GET") {
      return sendJson(res, 200, { total_count: 0, incomplete_results: false, items: [] });
    }
    if (rest[0] === "rate_limit" && method === "GET") {
      return sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1700000000, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: 1700000000, used: 1 } });
    }
    sendErr(res, 404, "Not Found");
  }

  async function handleRepoRest(
    _req: IncomingMessage,
    res: ServerResponse,
    method: string,
    owner: string,
    repoName: string,
    tail: string[],
    qp: URLSearchParams,
    b: Record<string, unknown>,
  ): Promise<void> {
    // Repo object itself
    if (tail.length === 0) {
      if (method === "GET") {
        const repo = store.findRepo(owner, repoName);
        if (!repo) return sendErr(res, 404, "Not Found");
        return sendJson(res, 200, repoJson(store, repo));
      }
      if (method === "PATCH") {
        const repo = store.findRepo(owner, repoName);
        if (!repo) return sendErr(res, 404, "Not Found");
        if (typeof b.description === "string") repo.description = b.description;
        if (typeof b.default_branch === "string" && b.default_branch) repo.defaultBranch = b.default_branch as string;
        repo.updatedAt = store.stamp();
        return sendJson(res, 200, repoJson(store, repo));
      }
      if (method === "DELETE") {
        const repo = store.findRepo(owner, repoName);
        if (!repo) return sendErr(res, 404, "Not Found");
        store.deleteRepo(repoName);
        res.writeHead(204, { "X-GitHub-Request-Id": "req-" + ++reqCounter });
        res.end();
        return;
      }
      return sendErr(res, 404, "Not Found");
    }

    const repo = store.findRepo(owner, repoName);
    if (!repo) return sendErr(res, 404, "Not Found");

    // contents
    if (tail[0] === "contents") {
      const path = tail.slice(1).join("/");
      if (method === "GET") {
        const head = branchHead(repo);
        if (!head) return sendErr(res, 404, "Not Found");
        if (!path) {
          const files = listFiles(repo, head);
          const entries: unknown[] = [];
          const seen = new Set<string>();
          for (const p of [...files.keys()].sort()) {
            const top = p.split("/")[0];
            if (seen.has(top)) continue;
            seen.add(top);
            const found = lookupPath(repo, head, top);
            entries.push({ name: top, path: top, sha: found?.sha || "", size: 0, type: found?.type === "tree" ? "dir" : "file", url: "", html_url: "", git_url: "", download_url: null });
          }
          return sendJson(res, 200, entries);
        }
        const found = lookupPath(repo, head, path);
        if (!found) return sendErr(res, 404, "Not Found");
        if (found.type === "tree") {
          const treeObj = repo.objects.get(found.sha);
          const entries: unknown[] = [];
          if (treeObj) {
            for (const e of parseTree(treeObj.data)) {
              entries.push({ name: e.name, path: path + "/" + e.name, sha: e.sha, size: 0, type: e.mode === "40000" ? "dir" : "file", url: "", html_url: "", git_url: "", download_url: null });
            }
          }
          return sendJson(res, 200, entries);
        }
        const blob = repo.objects.get(found.sha);
        const content = blob ? blob.data : Buffer.alloc(0);
        return sendJson(res, 200, {
          name: path.split("/").pop(),
          path,
          sha: found.sha,
          size: content.length,
          url: "",
          html_url: "",
          git_url: "",
          download_url: null,
          type: "file",
          content: content.toString("base64"),
          encoding: "base64",
        });
      }
      if (method === "PUT") {
        const contentB64 = String(b.content || "");
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, "base64");
        } catch {
          return sendErr(res, 400, "Invalid base64 content");
        }
        const branch = String(b.branch || repo.defaultBranch);
        const existingHead = headShaOf(repo, branch);
        const isUpdate = !!existingHead && !!lookupPath(repo, existingHead, path);
        if (isUpdate && b.sha && typeof b.sha === "string") {
          const cur = lookupPath(repo, existingHead, path);
          if (!cur || cur.sha !== b.sha) return sendErr(res, 409, "Conflict: sha does not match");
        }
        const sha = commitFileChange(store, repo, branch, path, content, String(b.message || "Update " + path));
        const blobSha = lookupPath(repo, sha, path)?.sha || "";
        return sendJson(res, isUpdate ? 200 : 201, {
          content: { name: path.split("/").pop(), path, sha: blobSha, size: content.length, type: "file", content: contentB64, encoding: "base64" },
          commit: { sha, message: String(b.message || "Update " + path), author: { name: "Forge", email: "forge@example.com" }, committer: { name: "Forge", email: "forge@example.com" } },
        });
      }
      if (method === "DELETE") {
        const branch = String(b.branch || repo.defaultBranch);
        const head = headShaOf(repo, branch);
        if (!head) return sendErr(res, 404, "Not Found");
        const cur = lookupPath(repo, head, path);
        if (!cur) return sendErr(res, 404, "Not Found");
        if (b.sha && typeof b.sha === "string" && cur.sha !== b.sha) return sendErr(res, 409, "Conflict: sha does not match");
        const sha = commitFileChange(store, repo, branch, path, null, String(b.message || "Delete " + path));
        return sendJson(res, 200, { commit: { sha, message: String(b.message || "Delete " + path) } });
      }
      return sendErr(res, 404, "Not Found");
    }

    // labels
    if (tail[0] === "labels") {
      if (method === "GET" && tail.length === 1) {
        return sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(store, repo, l)));
      }
      if (method === "POST" && tail.length === 1) {
        const name = String(b.name || "").trim();
        if (!name) return sendErr(res, 422, "Validation Failed: name is required");
        let label = repo.labels.get(name);
        if (!label) {
          label = { id: store.nextLabelId++, name, color: String(b.color || "ededed").replace("#", ""), description: String(b.description || "") };
          repo.labels.set(name, label);
        }
        return sendJson(res, 201, labelJson(store, repo, label));
      }
      if (method === "GET" && tail.length === 2) {
        const label = repo.labels.get(tail[1]);
        if (!label) return sendErr(res, 404, "Not Found");
        return sendJson(res, 200, labelJson(store, repo, label));
      }
      return sendErr(res, 404, "Not Found");
    }

    // issues
    if (tail[0] === "issues") {
      if (tail.length === 1) {
        if (method === "GET") {
          let list = [...repo.issues].sort((a, c) => c.number - a.number);
          const state = qp.get("state");
          if (state && state !== "all") list = list.filter((i) => i.state === state);
          const page = Math.max(1, parseInt(qp.get("page") || "1", 10) || 1);
          const perPage = Math.min(100, Math.max(1, parseInt(qp.get("per_page") || "30", 10) || 30));
          const slice = list.slice((page - 1) * perPage, page * perPage);
          const extra: Record<string, string> = {};
          if (page * perPage < list.length) extra.Link = `<https://api.github.com/repos/${owner}/${repoName}/issues?page=${page + 1}>; rel="next"`;
          return sendJson(res, 200, slice.map((i) => issueJson(store, repo, i)), extra);
        }
        if (method === "POST") {
          const title = String(b.title || "").trim();
          if (!title) return sendErr(res, 422, "Validation Failed: title is required");
          const labelNames: string[] = Array.isArray(b.labels) ? (b.labels as unknown[]).map((x) => (typeof x === "string" ? x : String((x as Record<string, unknown>).name || ""))) : [];
          for (const n of labelNames) {
            if (!repo.labels.has(n)) return sendErr(res, 422, "Validation Failed: label '" + n + "' does not exist");
          }
          const ts = store.now();
          const issue: Issue = {
            id: store.nextIssueId++,
            number: ++repo.issueCounter,
            title,
            body: String(b.body || ""),
            state: "open",
            labels: labelNames,
            createdAt: ts,
            updatedAt: ts,
            tick: store.tick,
            userLogin: store.ownerLogin(repo),
          };
          repo.issues.push(issue);
          return sendJson(res, 201, issueJson(store, repo, issue));
        }
        return sendErr(res, 404, "Not Found");
      }
      const num = parseInt(tail[1], 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) return sendErr(res, 404, "Not Found");
      if (tail.length === 2) {
        if (method === "GET") return sendJson(res, 200, issueJson(store, repo, issue));
        if (method === "PATCH") {
          if (typeof b.title === "string") issue.title = b.title;
          if (typeof b.body === "string") issue.body = b.body;
          if (typeof b.state === "string" && (b.state === "open" || b.state === "closed")) issue.state = b.state;
          if (Array.isArray(b.labels)) {
            const names = (b.labels as unknown[]).map((x) => (typeof x === "string" ? x : String((x as Record<string, unknown>).name || "")));
            for (const n of names) if (!repo.labels.has(n)) return sendErr(res, 422, "Validation Failed: label '" + n + "' does not exist");
            issue.labels = names;
          }
          issue.updatedAt = store.stamp();
          return sendJson(res, 200, issueJson(store, repo, issue));
        }
        return sendErr(res, 404, "Not Found");
      }
      if (tail[2] === "labels" && method === "GET") {
        return sendJson(res, 200, issue.labels.map((n) => repo.labels.get(n)).filter(Boolean).map((l) => labelJson(store, repo, l as NonNullable<typeof l>)));
      }
      return sendErr(res, 404, "Not Found");
    }

    // pulls
    if (tail[0] === "pulls") {
      if (tail.length === 1) {
        if (method === "GET") {
          let list = [...repo.pulls].sort((a, c) => c.number - a.number);
          const state = qp.get("state");
          if (state && state !== "all") list = list.filter((p) => p.state === state);
          return sendJson(res, 200, list.map((p) => pullJson(store, repo, p)));
        }
        if (method === "POST") {
          const title = String(b.title || "").trim();
          if (!title) return sendErr(res, 422, "Validation Failed: title is required");
          const headRef = String(b.head || "");
          const baseRef = String(b.base || repo.defaultBranch);
          const ts = store.now();
          const pr: Pull = {
            id: store.nextPullId++,
            number: ++repo.pullCounter,
            title,
            body: String(b.body || ""),
            state: "open",
            headRef,
            headSha: headShaOf(repo, headRef),
            baseRef,
            baseSha: headShaOf(repo, baseRef),
            merged: false,
            mergeable: true,
            mergeSha: "",
            createdAt: ts,
            updatedAt: ts,
            tick: store.tick,
            userLogin: store.ownerLogin(repo),
          };
          pr.mergeable = computeMergeable(repo, pr);
          repo.pulls.push(pr);
          return sendJson(res, 201, pullJson(store, repo, pr));
        }
        return sendErr(res, 404, "Not Found");
      }
      const num = parseInt(tail[1], 10);
      const pr = repo.pulls.find((p) => p.number === num);
      if (!pr) return sendErr(res, 404, "Not Found");
      if (tail.length === 2) {
        if (method === "GET") return sendJson(res, 200, pullJson(store, repo, pr));
        if (method === "PATCH") {
          if (typeof b.title === "string") pr.title = b.title;
          if (typeof b.body === "string") pr.body = b.body;
          if (typeof b.state === "string" && (b.state === "open" || b.state === "closed")) pr.state = b.state;
          pr.updatedAt = store.stamp();
          return sendJson(res, 200, pullJson(store, repo, pr));
        }
        return sendErr(res, 404, "Not Found");
      }
      if (tail[2] === "merge" && method === "PUT") {
        return mergePull(_req, res, repo, pr);
      }
      if (tail[2] === "files" && method === "GET") {
        return sendJson(res, 200, changedFiles(repo, pr));
      }
      if (tail[2] === "commits" && method === "GET") {
        return sendJson(res, 200, []);
      }
      return sendErr(res, 404, "Not Found");
    }

    // branches / git refs / commits (supporting reads)
    if (tail[0] === "branches" && method === "GET") {
      if (tail.length === 1) {
        return sendJson(res, 200, [...repo.branches.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, sha]) => ({ name, commit: { sha, url: "" }, protected: false })));
      }
      const sha = repo.branches.get(tail[1]);
      if (!sha) return sendErr(res, 404, "Not Found");
      return sendJson(res, 200, { name: tail[1], commit: { sha, url: "" }, protected: false });
    }
    if (tail[0] === "git" && tail[1] === "refs" && method === "GET") {
      const refs = refsOf(repo).map((r) => ({ ref: r.name, node_id: "REF_" + r.name, url: "", object: { sha: r.sha, type: "commit", url: "" } }));
      return sendJson(res, 200, refs);
    }
    if (tail[0] === "commits" && method === "GET") {
      const head = branchHead(repo);
      const out: unknown[] = [];
      let cur = head;
      const seen = new Set<string>();
      while (cur && !seen.has(cur) && out.length < 30) {
        seen.add(cur);
        const obj = repo.objects.get(cur);
        if (!obj || obj.type !== "commit") break;
        const parsed = parseCommit(obj.data);
        out.push({ sha: cur, commit: { message: parsed.message.trim(), author: { name: "Forge", email: "forge@example.com" }, committer: { name: "Forge", email: "forge@example.com" }, tree: { sha: parsed.tree } }, parents: parsed.parents.map((p) => ({ sha: p })) });
        cur = parsed.parents[0] || "";
      }
      return sendJson(res, 200, out);
    }
    if (tail[0] === "readme" && method === "GET") {
      const head = branchHead(repo);
      if (!head) return sendErr(res, 404, "Not Found");
      const found = lookupPath(repo, head, "README.md");
      if (!found) return sendErr(res, 404, "Not Found");
      const blob = repo.objects.get(found.sha);
      return sendJson(res, 200, { name: "README.md", path: "README.md", sha: found.sha, size: blob?.data.length || 0, type: "file", content: (blob?.data || Buffer.alloc(0)).toString("base64"), encoding: "base64" });
    }
    sendErr(res, 404, "Not Found");
  }

  function computeMergeable(repo: Repo, pr: Pull): boolean {
    const headSha = pr.headSha || headShaOf(repo, pr.headRef);
    const baseSha = pr.baseSha || headShaOf(repo, pr.baseRef);
    if (!headSha || !baseSha) return true;
    if (headSha === baseSha) return false;
    const base = mergeBase(repo, headSha, baseSha);
    if (!base) return true;
    if (base === baseSha) return true; // fast-forwardable
    // Three-way file conflict check.
    const baseFiles = listFiles(repo, base);
    const headFiles = listFiles(repo, headSha);
    const baseBranchFiles = listFiles(repo, baseSha);
    const all = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseBranchFiles.keys()]);
    for (const p of all) {
      const b0 = baseFiles.get(p);
      const h = headFiles.get(p);
      const bb = baseBranchFiles.get(p);
      const headChanged = h !== b0;
      const baseChanged = bb !== b0;
      if (headChanged && baseChanged && h !== bb) return false;
    }
    return true;
  }

  function changedFiles(repo: Repo, pr: Pull): unknown[] {
    const headSha = pr.headSha || headShaOf(repo, pr.headRef);
    const baseSha = pr.baseSha || headShaOf(repo, pr.baseRef);
    if (!headSha || !baseSha) return [];
    const headFiles = listFiles(repo, headSha);
    const baseFiles = listFiles(repo, baseSha);
    const all = new Set([...headFiles.keys(), ...baseFiles.keys()]);
    const out: unknown[] = [];
    for (const p of [...all].sort()) {
      if (headFiles.get(p) !== baseFiles.get(p)) {
        const status = !baseFiles.has(p) ? "added" : !headFiles.has(p) ? "removed" : "modified";
        out.push({ sha: headFiles.get(p) || baseFiles.get(p), filename: p, status, additions: 1, deletions: 0, changes: 1, blob_url: "", raw_url: "", contents_url: "", patch: "" });
      }
    }
    return out;
  }

  function mergePull(_req: IncomingMessage, res: ServerResponse, repo: Repo, pr: Pull): void {
    if (pr.state !== "open") return sendErr(res, 405, "Pull request is not open");
    const headSha = pr.headSha || headShaOf(repo, pr.headRef);
    const baseSha = pr.baseSha || headShaOf(repo, pr.baseRef);
    if (!headSha || !baseSha) return sendErr(res, 405, "Pull request cannot be merged");
    pr.mergeable = computeMergeable(repo, pr);
    if (!pr.mergeable) return sendErr(res, 405, "Merge conflict");
    // Squash merge: new commit on base branch with head's tree.
    const headObj = repo.objects.get(headSha);
    if (!headObj || headObj.type !== "commit") return sendErr(res, 405, "Pull request cannot be merged");
    const headTree = parseCommit(headObj.data).tree;
    const message = "Merge pull request #" + pr.number + " from " + pr.headRef;
    const mergeSha = makeCommit(repo, headTree, [baseSha], message);
    repo.branches.set(pr.baseRef, mergeSha);
    repo.packCache.clear();
    pr.state = "closed";
    pr.merged = true;
    pr.mergeSha = mergeSha;
    pr.updatedAt = store.stamp();
    sendJson(res, 200, { sha: mergeSha, merged: true, message });
  }

  // ---------------- git smart HTTP ----------------
  function sendGit(res: ServerResponse, contentType: string, body: Buffer): void {
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "Content-Length": String(body.length),
    });
    res.end(body);
  }

  async function handleGit(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    url: string,
    parts: string[],
  ): Promise<void> {
    // parts: [owner, "repo.git", ...] or [owner, "repo.git"] for info/refs etc.
    // Find the .git segment.
    const gitIdx = parts.findIndex((p) => p.endsWith(".git"));
    if (gitIdx < 0) return sendErr(res, 404, "Not Found");
    const owner = parts[gitIdx - 1] || "";
    const repoName = parts[gitIdx].slice(0, -4);
    const tail = parts.slice(gitIdx + 1);
    const repo = store.findRepo(owner, repoName);
    const qp = queryParams(url);
    const isV2 = (req.headers["git-protocol"] || "") === "version=2";

    if (method === "GET" && tail[0] === "info" && tail[1] === "refs") {
      const service = qp.get("service") || "";
      if (!repo) return sendErr(res, 404, "Not Found");
      if (service === "git-upload-pack") {
        if (isV2) {
          const adv = Buffer.concat([
            pktLine("version 2\n"),
            pktLine("agent=forge/1.0\n"),
            pktLine("ls-refs=unborn\n"),
            pktLine("fetch=shallow wait-for-done\n"),
            pktLine("server-option\n"),
            pktLine("object-format=sha1\n"),
            pktFlush(),
          ]);
          sendGit(res, "application/x-git-upload-pack-advertisement", adv);
          return;
        }
        const refs = refsOf(repo);
        const chunks: Buffer[] = [pktLine("# service=git-upload-pack\n"), pktFlush()];
        if (refs.length === 0) {
          chunks.push(pktLine("0000000000000000000000000000000000000000 capabilities^{}\0side-band-64k ofs-delta agent=forge/1.0\n"));
        } else {
          refs.forEach((r, i) => {
            if (i === 0) chunks.push(pktLine(r.sha + " " + r.name + "\0side-band-64k ofs-delta agent=forge/1.0\n"));
            else chunks.push(pktLine(r.sha + " " + r.name + "\n"));
          });
        }
        chunks.push(pktFlush());
        sendGit(res, "application/x-git-upload-pack-advertisement", Buffer.concat(chunks));
        return;
      }
      if (service === "git-receive-pack") {
        const refs = refsOf(repo);
        const chunks: Buffer[] = [pktLine("# service=git-receive-pack\n"), pktFlush()];
        if (refs.length === 0) {
          chunks.push(pktLine("0000000000000000000000000000000000000000 capabilities^{}\0report-status side-band-64k delete-refs ofs-delta agent=forge/1.0\n"));
        } else {
          refs.forEach((r, i) => {
            if (i === 0) chunks.push(pktLine(r.sha + " " + r.name + "\0report-status side-band-64k delete-refs ofs-delta agent=forge/1.0\n"));
            else chunks.push(pktLine(r.sha + " " + r.name + "\n"));
          });
        }
        chunks.push(pktFlush());
        sendGit(res, "application/x-git-receive-pack-advertisement", Buffer.concat(chunks));
        return;
      }
      return sendErr(res, 404, "Not Found");
    }

    if (method === "POST" && tail[0] === "git-upload-pack") {
      if (!repo) return sendErr(res, 404, "Not Found");
      const body = await readBody(req);
      if (isV2) {
        await handleUploadPackV2(repo, body, res);
        return;
      }
      await handleUploadPackV0(repo, body, res);
      return;
    }

    if (method === "POST" && tail[0] === "git-receive-pack") {
      if (!repo) return sendErr(res, 404, "Not Found");
      const body = await readBody(req);
      await handleReceivePack(repo, body, res);
      return;
    }
    sendErr(res, 404, "Not Found");
  }

  async function handleUploadPackV0(repo: Repo, body: Buffer, res: ServerResponse): Promise<void> {
    const { lines } = readPktLines(body);
    const wants: string[] = [];
    const haves = new Set<string>();
    for (const line of lines) {
      const text = line.toString("utf8").trim();
      const m = text.match(/^(want|have)\s+([0-9a-f]{40})/);
      if (m && m[1] === "want") wants.push(m[2]);
      else if (m && m[1] === "have") haves.add(m[2]);
    }
    if (wants.length === 0) {
      sendGit(res, "application/x-git-upload-pack-result", pktFlush());
      return;
    }
    const cacheKey = "v0:" + [...wants].sort().join(",") + "|" + [...haves].sort().join(",");
    let pack = repo.packCache.get(cacheKey);
    if (!pack) {
      const objs = collectReachable(repo, wants, haves, new Set());
      pack = buildPack(objs);
      repo.packCache.set(cacheKey, pack);
    }
    const chunks: Buffer[] = [pktLine("NAK\n")];
    const CHUNK = 65500;
    for (let off = 0; off < pack.length; off += CHUNK) {
      const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    chunks.push(pktFlush());
    sendGit(res, "application/x-git-upload-pack-result", Buffer.concat(chunks));
  }

  async function handleUploadPackV2(repo: Repo, body: Buffer, res: ServerResponse): Promise<void> {
    const { lines } = readPktLines(body);
    let command = "";
    const wants: string[] = [];
    const haves = new Set<string>();
    const shallows = new Set<string>();
    let deepen = 0;
    let sidebandAll = false;
    for (const line of lines) {
      const text = line.toString("utf8").trim();
      if (text.startsWith("command=")) command = text.slice(8);
      else if (text.startsWith("want ")) wants.push(text.slice(5).split(" ")[0]);
      else if (text.startsWith("have ")) haves.add(text.slice(5).trim());
      else if (text.startsWith("shallow ")) shallows.add(text.slice(8).trim());
      else if (text.startsWith("deepen ")) deepen = parseInt(text.slice(7), 10) || 0;
      else if (text === "sideband-all") sidebandAll = true;
    }
    if (command === "ls-refs") {
      const refs = refsOf(repo);
      const chunks: Buffer[] = [];
      // HEAD first with symref attribute
      const headSha = repo.branches.get(repo.defaultBranch);
      if (headSha) chunks.push(pktLine(headSha + " HEAD symref-target:refs/heads/" + repo.defaultBranch + "\n"));
      for (const r of refs) {
        if (r.name === "HEAD") continue;
        chunks.push(pktLine(r.sha + " " + r.name + "\n"));
      }
      chunks.push(pktFlush());
      sendGit(res, "application/x-git-upload-pack-result", Buffer.concat(chunks));
      return;
    }
    if (command === "fetch") {
      if (wants.length === 0) {
        sendGit(res, "application/x-git-upload-pack-result", pktFlush());
        return;
      }
      const shallowSet = new Set<string>(shallows);
      if (deepen > 0) for (const w of wants) shallowSet.add(w);
      const cacheKey = "v2:" + [...wants].sort().join(",") + "|" + [...haves].sort().join(",") + "|" + deepen;
      let pack = repo.packCache.get(cacheKey);
      if (!pack) {
        const objs = collectReachable(repo, wants, haves, shallowSet);
        pack = buildPack(objs);
        repo.packCache.set(cacheKey, pack);
      }
      const chunks: Buffer[] = [];
      // The acknowledgments section is only read when the client sent
      // "have" lines. A deepen-only (shallow) fetch expects the packfile
      // directly, so no acknowledgment section is sent for it.
      if (haves.size > 0) {
        chunks.push(pktLine("acknowledgments\n"));
        for (const s of [...shallowSet].sort()) chunks.push(pktLine("shallow " + s + "\n"));
        chunks.push(pktLine("ready\n"));
        // After "ready" the acknowledgments section ends with a DELIM
        // packet (0001), not a flush — the packfile section follows it.
        chunks.push(pktDelim());
      }
      // A shallow fetch needs a shallow-info section so the client learns
      // the boundary commits without receiving their parents.
      if (shallowSet.size > 0) {
        chunks.push(pktLine("shallow-info\n"));
        for (const s of [...shallowSet].sort()) chunks.push(pktLine("shallow " + s + "\n"));
        chunks.push(pktFlush());
      }
      chunks.push(pktLine("packfile\n"));
      // Protocol v2 fetch packfiles are always sent framed as sideband
      // packets (channel 1), regardless of a sideband-all request line.
      const CHUNK = 65500;
      for (let off = 0; off < pack.length; off += CHUNK) {
        const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
        chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
      }
      void sidebandAll;
      chunks.push(pktFlush());
      sendGit(res, "application/x-git-upload-pack-result", Buffer.concat(chunks));
      return;
    }
    // Unknown v2 command: empty response.
    sendGit(res, "application/x-git-upload-pack-result", pktFlush());
  }

  async function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): Promise<void> {
    const { lines, rest } = readPktLines(body);
    interface Update { oldSha: string; newSha: string; ref: string }
    const updates: Update[] = [];
    for (const line of lines) {
      let text = line.toString("utf8");
      const nul = text.indexOf("\0");
      if (nul >= 0) text = text.slice(0, nul);
      const m = text.trim().match(/^([0-9a-f]{40})\s+([0-9a-f]{40})\s+(\S+)/);
      if (m) updates.push({ oldSha: m[1], newSha: m[2], ref: m[3] });
    }
    let unpackOk = true;
    let unpackErr = "";
    if (rest.length > 0) {
      try {
        parsePack(repo, rest);
      } catch (e) {
        unpackOk = false;
        unpackErr = String((e as Error)?.message || e);
      }
    }
    // The whole report-status reply is ONE sideband packet (channel 1)
    // whose payload is the complete report as pkt-lines, including its
    // own terminating flush; a plain flush pkt then ends the sideband
    // stream. (The client's demultiplexer writes the payload raw to a
    // pipe, where the status reader needs that inner flush — an EOF
    // there is reported as "the remote end hung up".)
    const inner: Buffer[] = [];
    if (unpackOk) inner.push(pktLine("unpack ok\n"));
    else inner.push(pktLine("unpack " + unpackErr + "\n"));
    const ZERO = "0000000000000000000000000000000000000000";
    for (const u of updates) {
      if (!unpackOk) {
        inner.push(pktLine("ng " + u.ref + " unpack failed\n"));
        continue;
      }
      const branch = u.ref.startsWith("refs/heads/") ? u.ref.slice("refs/heads/".length) : null;
      if (!branch) {
        inner.push(pktLine("ng " + u.ref + " unsupported ref\n"));
        continue;
      }
      const current = repo.branches.get(branch) || ZERO;
      if (u.oldSha !== ZERO && u.oldSha !== current) {
        inner.push(pktLine("ng " + u.ref + " non-fast-forward\n"));
        continue;
      }
      if (u.newSha === ZERO) {
        repo.branches.delete(branch);
        inner.push(pktLine("ok " + u.ref + "\n"));
        continue;
      }
      const obj = repo.objects.get(u.newSha);
      if (!obj || obj.type !== "commit") {
        inner.push(pktLine("ng " + u.ref + " invalid object\n"));
        continue;
      }
      if (u.oldSha !== ZERO && !isAncestor(repo, u.oldSha, u.newSha)) {
        inner.push(pktLine("ng " + u.ref + " non-fast-forward\n"));
        continue;
      }
      repo.branches.set(branch, u.newSha);
      repo.updatedAt = store.stamp();
      repo.packCache.clear();
      inner.push(pktLine("ok " + u.ref + "\n"));
    }
    inner.push(pktFlush());
    const chunks: Buffer[] = [
      pktLine(Buffer.concat([Buffer.from([1]), Buffer.concat(inner)])),
      pktFlush(),
    ];
    sendGit(res, "application/x-git-receive-pack-result", Buffer.concat(chunks));
  }

  // ---------------- GraphQL ----------------
  async function handleGraphql(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
    if (method !== "POST") return sendErr(res, 404, "Not Found");
    const buf = await readBody(req);
    const parsed = parseJsonBody(buf);
    if (!parsed.ok) return sendErr(res, 400, "Problems parsing JSON");
    const payload = parsed.value;
    if (Array.isArray(payload)) {
      const results = payload.map((doc) => executeGraphql(doc as Record<string, unknown>));
      return sendJson(res, 200, results);
    }
    return sendJson(res, 200, executeGraphql(payload as Record<string, unknown>));
  }

  function executeGraphql(doc: Record<string, unknown>): Record<string, unknown> {
    const query = String(doc.query || "");
    const variables = (doc.variables || {}) as Record<string, unknown>;
    const operationName = typeof doc.operationName === "string" ? doc.operationName : undefined;
    try {
      const ops = parseGraphql(query);
      if (ops.length === 0) return { data: null, errors: [{ message: "No operation provided" }] };
      let op = ops[0];
      if (operationName) {
        const found = ops.find((o) => o.name === operationName);
        if (found) op = found;
      }
      const data: Record<string, unknown> = {};
      const errors: { message: string }[] = [];
      for (const field of op.selections) {
        const val = resolveRootField(field, variables, errors);
        data[field.alias || field.name] = val;
      }
      if (errors.length > 0) return { data, errors };
      return { data };
    } catch (e) {
      return { data: null, errors: [{ message: String((e as Error)?.message || e) }] };
    }
  }

  // Minimal GraphQL document parser.
  interface GqlField { name: string; alias?: string; args: Record<string, unknown>; selections: GqlField[] }
  interface GqlOp { type: string; name?: string; selections: GqlField[] }

  function parseGraphql(src: string): GqlOp[] {
    // Tokenize
    type Tok = { kind: string; value: string };
    const toks: Tok[] = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === " " || c === "\n" || c === "\t" || c === "\r" || c === ",") { i++; continue; }
      if (c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "." && src.slice(i, i + 3) === "...") { toks.push({ kind: "spread", value: "..." }); i += 3; continue; }
      if ("{}():!$[]=|&".includes(c)) { toks.push({ kind: c, value: c }); i++; continue; }
      if (c === '"') {
        let j = i + 1;
        let out = "";
        while (j < src.length && src[j] !== '"') {
          if (src[j] === "\\" && j + 1 < src.length) { out += src[j + 1]; j += 2; } else { out += src[j]; j++; }
        }
        toks.push({ kind: "string", value: out });
        i = j + 1;
        continue;
      }
      if (c === "$") {
        let j = i + 1;
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
        toks.push({ kind: "var", value: src.slice(i + 1, j) });
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
        toks.push({ kind: "name", value: src.slice(i, j) });
        i = j;
        continue;
      }
      if (/[0-9-]/.test(c)) {
        let j = i;
        while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
        toks.push({ kind: "number", value: src.slice(i, j) });
        i = j;
        continue;
      }
      i++;
    }
    let pos = 0;
    const peek = (): Tok | undefined => toks[pos];
    const next = (): Tok | undefined => toks[pos++];
    const expect = (kind: string): Tok => {
      const t = next();
      if (!t || t.kind !== kind) throw new Error("Expected " + kind + " in GraphQL query");
      return t;
    };
    const parseValue = (): unknown => {
      const t = peek();
      if (!t) throw new Error("Unexpected end of query");
      if (t.kind === "string") { next(); return t.value; }
      if (t.kind === "number") { next(); return Number(t.value); }
      if (t.kind === "var") { next(); return { __var: t.value }; }
      if (t.kind === "{") {
        next();
        const obj: Record<string, unknown> = {};
        while (peek() && peek()?.kind !== "}") {
          const k = expect("name").value;
          expect(":");
          obj[k] = parseValue();
        }
        expect("}");
        return obj;
      }
      if (t.kind === "[") {
        next();
        const arr: unknown[] = [];
        while (peek() && peek()?.kind !== "]") arr.push(parseValue());
        expect("]");
        return arr;
      }
      if (t.kind === "name") {
        next();
        if (t.value === "true") return true;
        if (t.value === "false") return false;
        if (t.value === "null") return null;
        return { __enum: t.value };
      }
      throw new Error("Unexpected token " + t.kind);
    };
    const parseArgs = (): Record<string, unknown> => {
      const args: Record<string, unknown> = {};
      if (peek()?.kind === "(") {
        next();
        while (peek() && peek()?.kind !== ")") {
          const k = expect("name").value;
          expect(":");
          args[k] = parseValue();
        }
        expect(")");
      }
      return args;
    };
    const parseSelections = (): GqlField[] => {
      expect("{");
      const fields: GqlField[] = [];
      while (peek() && peek()?.kind !== "}") {
        if (peek()?.kind === "spread") {
          next();
          // fragment spread or inline fragment: skip name / "on Type", parse its selections
          if (peek()?.kind === "name" && peek()?.value === "on") {
            next(); expect("name");
          } else if (peek()?.kind === "name") {
            next();
          }
          if (peek()?.kind === "{") fields.push(...parseSelections());
          continue;
        }
        const first = expect("name").value;
        let alias: string | undefined;
        let name = first;
        if (peek()?.kind === ":") {
          next();
          alias = first;
          name = expect("name").value;
        }
        const args = parseArgs();
        let selections: GqlField[] = [];
        if (peek()?.kind === "{") selections = parseSelections();
        fields.push({ name, alias, args, selections });
      }
      expect("}");
      return fields;
    };
    const ops: GqlOp[] = [];
    while (pos < toks.length) {
      const t = peek();
      if (!t) break;
      if (t.kind === "{") {
        ops.push({ type: "query", selections: parseSelections() });
      } else if (t.kind === "name" && (t.value === "query" || t.value === "mutation" || t.value === "subscription")) {
        next();
        let name: string | undefined;
        if (peek()?.kind === "name") name = next()?.value;
        // variable definitions: skip balanced parens
        if (peek()?.kind === "(") {
          let depth = 0;
          while (pos < toks.length) {
            const tk = next() as Tok;
            if (tk.kind === "(") depth++;
            else if (tk.kind === ")") { depth--; if (depth === 0) break; }
          }
        }
        ops.push({ type: t.value, name, selections: parseSelections() });
      } else {
        next();
      }
    }
    return ops;
  }

  function resolveVars(value: unknown, variables: Record<string, unknown>): unknown {
    if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if ("__var" in v) return variables[String(v.__var)];
      if ("__enum" in v) return String(v.__enum);
      if (Array.isArray(value)) return (value as unknown[]).map((x) => resolveVars(x, variables));
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = resolveVars(val, variables);
      return out;
    }
    return value;
  }

  function resolveArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(field.args)) out[k] = resolveVars(v, variables);
    return out;
  }

  const REPO_FIELDS = new Set(["id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "description", "url", "createdAt", "updatedAt", "isPrivate", "viewerHasStarred", "labels", "stargazerCount", "forkCount", "licenseInfo", "homepageUrl", "isArchived", "isFork", "visibility", "resourcePath", "primaryLanguage", "__typename"]);
  const ISSUE_FIELDS = new Set(["id", "databaseId", "number", "title", "state", "body", "bodyText", "createdAt", "updatedAt", "closedAt", "author", "labels", "url", "resourcePath", "comments", "assignees", "milestone", "locked", "__typename"]);
  const PR_FIELDS = new Set(["id", "databaseId", "number", "title", "state", "body", "bodyText", "createdAt", "updatedAt", "closedAt", "mergedAt", "author", "headRefName", "baseRefName", "headRef", "baseRef", "mergeable", "merged", "files", "labels", "url", "resourcePath", "isDraft", "mergeStateStatus", "__typename"]);
  const CONNECTION_FIELDS = new Set(["nodes", "edges", "totalCount", "pageInfo", "__typename"]);
  const TYPE_FIELDS: Record<string, Set<string>> = { Repository: REPO_FIELDS, Issue: ISSUE_FIELDS, PullRequest: PR_FIELDS };

  function checkFields(typeName: string, fields: GqlField[], errors: { message: string }[]): void {
    const known = TYPE_FIELDS[typeName];
    if (!known) return;
    for (const f of fields) {
      if (!known.has(f.name)) errors.push({ message: 'Cannot query field "' + f.name + '" on type "' + typeName + '".' });
    }
  }

  function resolveRootField(field: GqlField, variables: Record<string, unknown>, errors: { message: string }[]): unknown {
    const args = resolveArgs(field, variables);
    if (field.name === "__typename") return "Query";
    if (field.name === "__type") {
      return resolveIntrospectionType(String(args.name || ""), field.selections);
    }
    if (field.name === "__schema") {
      return {
        queryType: { name: "Query" },
        mutationType: { name: "Mutation" },
        types: [
          { name: "Query", kind: "OBJECT" },
          { name: "Mutation", kind: "OBJECT" },
          { name: "Repository", kind: "OBJECT" },
          { name: "Issue", kind: "OBJECT" },
          { name: "PullRequest", kind: "OBJECT" },
          { name: "SearchType", kind: "ENUM" },
        ],
        directives: [],
      };
    }
    if (field.name === "repository") {
      const owner = String(args.owner || "");
      const name = String(args.name || "");
      const repo = store.findRepo(owner, name);
      if (!repo) return null;
      checkFields("Repository", field.selections, errors);
      return resolveRepo(repo, field.selections, variables, errors);
    }
    if (field.name === "viewer") {
      const login = store.tokenLogin() || "owner";
      const out: Record<string, unknown> = {};
      for (const f of field.selections) {
        if (f.name === "login") out[f.alias || f.name] = login;
        else if (f.name === "id") out[f.alias || f.name] = "U_1";
        else if (f.name === "__typename") out[f.alias || f.name] = "User";
        else errors.push({ message: 'Cannot query field "' + f.name + '" on type "User".' });
      }
      return out;
    }
    if (field.name === "node") {
      const id = String(args.id || "");
      const m = id.match(/^([A-Z]+)_(\d+)$/);
      if (!m) return null;
      return { id };
    }
    if (field.name === "search") {
      return { nodes: [], edges: [], issueCount: 0, repositoryCount: 0, userCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    }
    if (field.name === "createPullRequest") {
      const input = (args.input || {}) as Record<string, unknown>;
      const repoId = String(input.repositoryId || "");
      const m = repoId.match(/^R_(\d+)$/);
      let repo: Repo | null = null;
      if (m) repo = store.listRepos().find((r) => r.id === Number(m[1])) || null;
      if (!repo) return { pullRequest: null };
      const headRef = String(input.headRefName || "");
      const baseRef = String(input.baseRefName || repo.defaultBranch);
      const ts = store.now();
      const pr: Pull = {
        id: store.nextPullId++,
        number: ++repo.pullCounter,
        title: String(input.title || ""),
        body: String(input.body || ""),
        state: "open",
        headRef,
        headSha: headShaOf(repo, headRef),
        baseRef,
        baseSha: headShaOf(repo, baseRef),
        merged: false,
        mergeable: true,
        mergeSha: "",
        createdAt: ts,
        updatedAt: ts,
        tick: store.tick,
        userLogin: store.ownerLogin(repo),
      };
      repo.pulls.push(pr);
      const out: Record<string, unknown> = {};
      for (const f of field.selections) {
        if (f.name === "pullRequest") {
          checkFields("PullRequest", f.selections, errors);
          out[f.alias || f.name] = resolvePull(repo, pr, f.selections, variables, errors);
        } else if (f.name === "clientMutationId") out[f.alias || f.name] = input.clientMutationId || null;
        else errors.push({ message: 'Cannot query field "' + f.name + '" on type "CreatePullRequestPayload".' });
      }
      return out;
    }
    if (field.name === "createIssue") {
      const input = (args.input || {}) as Record<string, unknown>;
      const repoId = String(input.repositoryId || "");
      const m = repoId.match(/^R_(\d+)$/);
      let repo: Repo | null = null;
      if (m) repo = store.listRepos().find((r) => r.id === Number(m[1])) || null;
      if (!repo) return { issue: null };
      const ts = store.now();
      const issue: Issue = {
        id: store.nextIssueId++,
        number: ++repo.issueCounter,
        title: String(input.title || ""),
        body: String(input.body || ""),
        state: "open",
        labels: [],
        createdAt: ts,
        updatedAt: ts,
        tick: store.tick,
        userLogin: store.ownerLogin(repo),
      };
      repo.issues.push(issue);
      const out: Record<string, unknown> = {};
      for (const f of field.selections) {
        if (f.name === "issue") {
          checkFields("Issue", f.selections, errors);
          out[f.alias || f.name] = resolveIssue(repo, issue, f.selections, variables, errors);
        } else out[f.alias || f.name] = null;
      }
      return out;
    }
    errors.push({ message: 'Cannot query field "' + field.name + '" on type "Query".' });
    return null;
  }

  function resolveIntrospectionType(name: string, selections: GqlField[]): Record<string, unknown> {
    const fieldDefs: Record<string, { name: string; type: string }[]> = {
      Issue: [
        { name: "id", type: "ID" },
        { name: "number", type: "Int" },
        { name: "title", type: "String" },
        { name: "state", type: "IssueState" },
        { name: "body", type: "String" },
      ],
      PullRequest: [
        { name: "id", type: "ID" },
        { name: "number", type: "Int" },
        { name: "headRefName", type: "String" },
        { name: "baseRefName", type: "String" },
        { name: "mergeable", type: "Boolean" },
        { name: "state", type: "PullRequestState" },
        { name: "merged", type: "Boolean" },
        { name: "files", type: "PullRequestChangedFileConnection" },
      ],
      Repository: [
        { name: "id", type: "ID" },
        { name: "databaseId", type: "Int" },
        { name: "name", type: "String" },
        { name: "nameWithOwner", type: "String" },
        { name: "owner", type: "RepositoryOwner" },
        { name: "defaultBranchRef", type: "Ref" },
        { name: "viewerPermission", type: "RepositoryPermission" },
        { name: "hasIssuesEnabled", type: "Boolean" },
        { name: "issue", type: "Issue" },
        { name: "issues", type: "IssueConnection" },
        { name: "pullRequests", type: "PullRequestConnection" },
        { name: "pullRequest", type: "PullRequest" },
      ],
    };
    const out: Record<string, unknown> = {};
    for (const f of selections) {
      if (f.name === "name") out[f.alias || f.name] = name;
      else if (f.name === "kind") out[f.alias || f.name] = name === "SearchType" ? "ENUM" : "OBJECT";
      else if (f.name === "description") out[f.alias || f.name] = null;
      else if (f.name === "fields") {
        const defs = fieldDefs[name] || [];
        out[f.alias || f.name] = defs.map((d) => ({
          name: d.name,
          description: null,
          args: [],
          type: { name: d.type, kind: d.type === "String" || d.type === "Int" || d.type === "Boolean" || d.type === "ID" ? "SCALAR" : "OBJECT", ofType: null },
          isDeprecated: false,
          deprecationReason: null,
        }));
      } else if (f.name === "enumValues") {
        if (name === "SearchType") {
          out[f.alias || f.name] = [
            { name: "ISSUE", description: null, isDeprecated: false, deprecationReason: null },
            { name: "REPOSITORY", description: null, isDeprecated: false, deprecationReason: null },
            { name: "USER", description: null, isDeprecated: false, deprecationReason: null },
            { name: "DISCUSSION", description: null, isDeprecated: false, deprecationReason: null },
          ];
        } else out[f.alias || f.name] = null;
      } else if (f.name === "possibleTypes") out[f.alias || f.name] = null;
      else if (f.name === "inputFields") out[f.alias || f.name] = null;
      else if (f.name === "interfaces") out[f.alias || f.name] = [];
      else if (f.name === "ofType") out[f.alias || f.name] = null;
      else out[f.alias || f.name] = null;
    }
    return out;
  }

  function resolveRepo(repo: Repo, selections: GqlField[], variables: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const owner = store.ownerLogin(repo);
    for (const f of selections) {
      const key = f.alias || f.name;
      const args = resolveArgs(f, variables);
      switch (f.name) {
        case "__typename": out[key] = "Repository"; break;
        case "id": out[key] = "R_" + repo.id; break;
        case "databaseId": out[key] = repo.id; break;
        case "name": out[key] = repo.name; break;
        case "nameWithOwner": out[key] = owner + "/" + repo.name; break;
        case "description": out[key] = repo.description || null; break;
        case "url": out[key] = "https://github.com/" + owner + "/" + repo.name; break;
        case "resourcePath": out[key] = "/" + owner + "/" + repo.name; break;
        case "createdAt": out[key] = repo.createdAt; break;
        case "updatedAt": out[key] = repo.updatedAt; break;
        case "isPrivate": out[key] = false; break;
        case "visibility": out[key] = "PUBLIC"; break;
        case "owner": {
          const o: Record<string, unknown> = {};
          for (const sf of f.selections) {
            if (sf.name === "login") o[sf.alias || sf.name] = owner;
            else if (sf.name === "id") o[sf.alias || sf.name] = "U_" + repo.id;
            else if (sf.name === "__typename") o[sf.alias || sf.name] = "User";
            else o[sf.alias || sf.name] = null;
          }
          out[key] = o;
          break;
        }
        case "defaultBranchRef": {
          const o: Record<string, unknown> = {};
          for (const sf of f.selections) {
            if (sf.name === "name") o[sf.alias || sf.name] = repo.defaultBranch;
            else if (sf.name === "prefix") o[sf.alias || sf.name] = "refs/heads/";
            else if (sf.name === "__typename") o[sf.alias || sf.name] = "Ref";
            else if (sf.name === "target") o[sf.alias || sf.name] = { oid: repo.branches.get(repo.defaultBranch) || null };
            else o[sf.alias || sf.name] = null;
          }
          out[key] = o;
          break;
        }
        case "viewerPermission": out[key] = "ADMIN"; break;
        case "hasIssuesEnabled": out[key] = true; break;
        case "stargazerCount": out[key] = 0; break;
        case "forkCount": out[key] = 0; break;
        case "issue": {
          const num = Number(args.number);
          const issue = repo.issues.find((i) => i.number === num) || null;
          checkFields("Issue", f.selections, errors);
          out[key] = issue ? resolveIssue(repo, issue, f.selections, variables, errors) : null;
          break;
        }
        case "issues": {
          checkFields("Issue", f.selections.filter((s) => s.name === "nodes").flatMap((s) => s.selections), errors);
          out[key] = issueConnection(repo, f, args, variables, errors);
          break;
        }
        case "pullRequest": {
          const num = Number(args.number);
          const pr = repo.pulls.find((p) => p.number === num) || null;
          checkFields("PullRequest", f.selections, errors);
          out[key] = pr ? resolvePull(repo, pr, f.selections, variables, errors) : null;
          break;
        }
        case "pullRequests": {
          out[key] = pullConnection(repo, f, args, variables, errors);
          break;
        }
        case "labels": {
          const nodes = [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description, id: "L_" + l.id }));
          out[key] = connectionFromNodes(nodes, f, args);
          break;
        }
        default:
          errors.push({ message: 'Cannot query field "' + f.name + '" on type "Repository".' });
          out[key] = null;
      }
    }
    return out;
  }

  function connectionFromNodes(nodes: unknown[], field: GqlField, args: Record<string, unknown>): Record<string, unknown> {
    const first = typeof args.first === "number" ? args.first : nodes.length;
    const sliced = nodes.slice(0, first);
    const out: Record<string, unknown> = {};
    for (const f of field.selections) {
      if (f.name === "nodes") out[f.alias || f.name] = sliced;
      else if (f.name === "edges") out[f.alias || f.name] = sliced.map((n) => ({ node: n, cursor: "cursor" }));
      else if (f.name === "totalCount") out[f.alias || f.name] = nodes.length;
      else if (f.name === "pageInfo") out[f.alias || f.name] = { hasNextPage: nodes.length > sliced.length, hasPreviousPage: false, startCursor: null, endCursor: null };
      else out[f.alias || f.name] = null;
    }
    return out;
  }

  function issueConnection(repo: Repo, field: GqlField, args: Record<string, unknown>, variables: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
    let list = [...repo.issues];
    const states = args.states as unknown;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((s) => String(s)));
      list = list.filter((i) => wanted.has(i.state.toUpperCase()));
    }
    const orderBy = args.orderBy as Record<string, unknown> | undefined;
    if (orderBy && String(orderBy.field || "").toUpperCase() === "CREATED_AT") {
      const dir = String(orderBy.direction || "ASC").toUpperCase();
      list.sort((a, b) => {
        if (dir === "DESC") return b.tick - a.tick || b.number - a.number;
        return a.tick - b.tick || a.number - b.number;
      });
    } else {
      list.sort((a, b) => a.number - b.number);
    }
    const nodeSelections = field.selections.find((s) => s.name === "nodes")?.selections || [];
    const edgeSelections = field.selections.find((s) => s.name === "edges")?.selections || [];
    void edgeSelections;
    const resolved = list.map((i) => resolveIssue(repo, i, nodeSelections, variables, errors));
    return connectionFromNodes(resolved, field, args);
  }

  function pullConnection(repo: Repo, field: GqlField, args: Record<string, unknown>, variables: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
    let list = [...repo.pulls];
    const states = args.states as unknown;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((s) => String(s)));
      list = list.filter((p) => wanted.has(p.state.toUpperCase()));
    }
    const orderBy = args.orderBy as Record<string, unknown> | undefined;
    if (orderBy && String(orderBy.field || "").toUpperCase() === "CREATED_AT") {
      const dir = String(orderBy.direction || "ASC").toUpperCase();
      list.sort((a, b) => (dir === "DESC" ? b.tick - a.tick || b.number - a.number : a.tick - b.tick || a.number - b.number));
    } else {
      list.sort((a, b) => a.number - b.number);
    }
    const nodeSelections = field.selections.find((s) => s.name === "nodes")?.selections || [];
    const resolved = list.map((p) => resolvePull(repo, p, nodeSelections, variables, errors));
    return connectionFromNodes(resolved, field, args);
  }

  function resolveIssue(repo: Repo, issue: Issue, selections: GqlField[], _variables: Record<string, unknown>, _errors: { message: string }[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const owner = store.ownerLogin(repo);
    for (const f of selections) {
      const key = f.alias || f.name;
      switch (f.name) {
        case "__typename": out[key] = "Issue"; break;
        case "id": out[key] = "I_" + issue.id; break;
        case "databaseId": out[key] = issue.id; break;
        case "number": out[key] = issue.number; break;
        case "title": out[key] = issue.title; break;
        case "state": out[key] = issue.state.toUpperCase(); break;
        case "body": out[key] = issue.body; break;
        case "bodyText": out[key] = issue.body; break;
        case "createdAt": out[key] = issue.createdAt; break;
        case "updatedAt": out[key] = issue.updatedAt; break;
        case "closedAt": out[key] = issue.state === "closed" ? issue.updatedAt : null; break;
        case "url": out[key] = "https://github.com/" + owner + "/" + repo.name + "/issues/" + issue.number; break;
        case "resourcePath": out[key] = "/" + owner + "/" + repo.name + "/issues/" + issue.number; break;
        case "author": {
          const o: Record<string, unknown> = {};
          for (const sf of f.selections) {
            if (sf.name === "login") o[sf.alias || sf.name] = issue.userLogin;
            else if (sf.name === "__typename") o[sf.alias || sf.name] = "User";
            else o[sf.alias || sf.name] = null;
          }
          out[key] = o;
          break;
        }
        case "labels": {
          const nodes = issue.labels.map((n) => ({ name: n }));
          out[key] = connectionFromNodes(nodes, f, {});
          break;
        }
        case "comments": out[key] = { totalCount: 0, nodes: [] }; break;
        case "assignees": out[key] = { nodes: [], totalCount: 0 }; break;
        default: out[key] = null;
      }
    }
    return out;
  }

  function resolvePull(repo: Repo, pr: Pull, selections: GqlField[], _variables: Record<string, unknown>, _errors: { message: string }[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const owner = store.ownerLogin(repo);
    for (const f of selections) {
      const key = f.alias || f.name;
      switch (f.name) {
        case "__typename": out[key] = "PullRequest"; break;
        case "id": out[key] = "PR_" + pr.id; break;
        case "databaseId": out[key] = pr.id; break;
        case "number": out[key] = pr.number; break;
        case "title": out[key] = pr.title; break;
        case "state": out[key] = pr.state.toUpperCase(); break;
        case "body": out[key] = pr.body; break;
        case "bodyText": out[key] = pr.body; break;
        case "createdAt": out[key] = pr.createdAt; break;
        case "updatedAt": out[key] = pr.updatedAt; break;
        case "closedAt": out[key] = pr.state === "closed" ? pr.updatedAt : null; break;
        case "mergedAt": out[key] = pr.merged ? pr.updatedAt : null; break;
        case "headRefName": out[key] = pr.headRef; break;
        case "baseRefName": out[key] = pr.baseRef; break;
        case "mergeable": out[key] = pr.mergeable; break;
        case "merged": out[key] = pr.merged; break;
        case "isDraft": out[key] = false; break;
        case "mergeStateStatus": out[key] = pr.mergeable ? "CLEAN" : "DIRTY"; break;
        case "url": out[key] = "https://github.com/" + owner + "/" + repo.name + "/pull/" + pr.number; break;
        case "resourcePath": out[key] = "/" + owner + "/" + repo.name + "/pull/" + pr.number; break;
        case "headRef": out[key] = { name: pr.headRef, prefix: "refs/heads/" }; break;
        case "baseRef": out[key] = { name: pr.baseRef, prefix: "refs/heads/" }; break;
        case "author": {
          const o: Record<string, unknown> = {};
          for (const sf of f.selections) {
            if (sf.name === "login") o[sf.alias || sf.name] = pr.userLogin;
            else if (sf.name === "__typename") o[sf.alias || sf.name] = "User";
            else o[sf.alias || sf.name] = null;
          }
          out[key] = o;
          break;
        }
        case "files": {
          const files = changedFiles(repo, pr) as { filename: string }[];
          const nodes = files.map((x) => ({ path: x.filename, additions: 1, deletions: 0 }));
          out[key] = connectionFromNodes(nodes, f, {});
          break;
        }
        case "labels": out[key] = { nodes: [], totalCount: 0 }; break;
        default: out[key] = null;
      }
    }
    return out;
  }

  // ---------------- MCP ----------------
  const MCP_TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
    {
      name: "create_repo",
      description: "Create a new repository for the authenticated user.",
      inputSchema: { type: "object", properties: { name: { type: "string", description: "Repository name" }, description: { type: "string", description: "Repository description" } }, required: ["name"] },
    },
    {
      name: "get_repo",
      description: "Get a repository by owner and repo name.",
      inputSchema: { type: "object", properties: { owner: { type: "string", description: "Repository owner" }, repo: { type: "string", description: "Repository name" }, full_name: { type: "string", description: "Owner/repo full name" } }, required: ["owner", "repo"] },
    },
    {
      name: "create_issue",
      description: "Create an issue in a repository.",
      inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string", description: "Issue title" }, body: { type: "string", description: "Issue body" }, full_name: { type: "string" } }, required: ["owner", "repo", "title"] },
    },
    {
      name: "list_issues",
      description: "List issues in a repository, optionally filtered by state.",
      inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string", description: "open, closed, or all" }, full_name: { type: "string" } }, required: ["owner", "repo"] },
    },
    {
      name: "create_pull_request",
      description: "Create a pull request in a repository.",
      inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string", description: "Pull request title" }, head: { type: "string", description: "Head branch name" }, base: { type: "string", description: "Base branch name" }, body: { type: "string" }, full_name: { type: "string" } }, required: ["owner", "repo", "title", "head", "base"] },
    },
    {
      name: "merge_pull_request",
      description: "Merge a pull request in a repository.",
      inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "integer", description: "Pull request number" }, full_name: { type: "string" } }, required: ["owner", "repo", "pull_number"] },
    },
    {
      name: "list_repos",
      description: "List repositories of the authenticated user.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_issue",
      description: "Get a single issue by number in a repository.",
      inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "integer" }, full_name: { type: "string" } }, required: ["owner", "repo", "issue_number"] },
    },
  ];

  function mcpResolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
    let owner = String(args.owner || "");
    let repo = String(args.repo || "");
    const full = String(args.full_name || args.fullName || "");
    if ((!owner || !repo) && full.includes("/")) {
      const [o, r] = full.split("/");
      owner = owner || o;
      repo = repo || r;
    }
    // Nearest-property mapping: some clients use repository/repositoryName.
    if (!repo) repo = String(args.repository || args.repositoryName || "");
    if (!owner) owner = String(args.ownerLogin || "");
    return { owner, repo };
  }

  function mcpText(text: string): Record<string, unknown> {
    return { content: [{ type: "text", text }], structuredContent: safeParse(text) };
  }
  function safeParse(text: string): unknown {
    try { return JSON.parse(text); } catch { return undefined; }
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
    if (method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "Method not allowed" } }));
      return;
    }
    const buf = await readBody(req);
    const parsed = parseJsonBody(buf);
    if (!parsed.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }
    const msg = parsed.value as Record<string, unknown>;
    const id = msg.id !== undefined ? msg.id : null;
    const methodName = String(msg.method || "");
    const params = (msg.params || {}) as Record<string, unknown>;
    const sessionId = req.headers["mcp-session-id"];
    const extraHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (typeof sessionId === "string" && sessionId) extraHeaders["Mcp-Session-Id"] = sessionId;

    const reply = (status: number, payload: unknown): void => {
      const body = JSON.stringify(payload);
      res.writeHead(status, { ...extraHeaders, "Content-Length": String(Buffer.byteLength(body)) });
      res.end(body);
    };

    // Notifications have no id: 202, no body.
    if (id === null && methodName.startsWith("notifications/")) {
      res.writeHead(202, extraHeaders);
      res.end();
      return;
    }

    if (methodName === "initialize") {
      const requested = String((params.protocolVersion as string) || "2026-07-28");
      const versions = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
      const protocolVersion = versions.includes(requested) ? requested : "2026-07-28";
      return reply(200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
          serverInfo: { name: "github-forge", version: "1.0.0" },
          supportedVersions: versions,
          instructions: "GitHub-compatible forge MCP server.",
        },
      });
    }
    if (methodName === "server/discover" || methodName === "discover") {
      return reply(200, { jsonrpc: "2.0", id, result: { supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"], protocolVersion: "2026-07-28", serverInfo: { name: "github-forge", version: "1.0.0" } } });
    }
    if (methodName === "ping") {
      return reply(200, { jsonrpc: "2.0", id, result: {} });
    }
    if (methodName === "notifications/initialized") {
      res.writeHead(202, extraHeaders);
      res.end();
      return;
    }
    if (methodName === "tools/list") {
      return reply(200, { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
    }
    if (methodName === "tools/call") {
      const name = String((params as Record<string, unknown>).name || "");
      const args = ((params as Record<string, unknown>).arguments || {}) as Record<string, unknown>;
      const tool = MCP_TOOLS.find((t) => {
        const tn = t.name.toLowerCase();
        const rn = name.toLowerCase();
        return rn === tn || rn.endsWith("__" + tn) || rn.endsWith(tn);
      });
      if (!tool) {
        return reply(200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool: " + name } });
      }
      const missing = (tool.inputSchema.required as string[] || []).filter((r) => {
        if (r === "owner" || r === "repo") {
          const { owner, repo } = mcpResolveOwnerRepo(args);
          return r === "owner" ? !owner : !repo;
        }
        return args[r] === undefined || args[r] === null || args[r] === "";
      });
      if (missing.length > 0) {
        return reply(200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Missing required argument: " + missing.join(", ") }], isError: true } });
      }
      try {
        const result = mcpCall(tool.name, args);
        if (result && typeof result === "object" && "error" in (result as Record<string, unknown>)) {
          return reply(200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String((result as Record<string, unknown>).error) }], isError: true } });
        }
        return reply(200, { jsonrpc: "2.0", id, result: mcpText(JSON.stringify(result)) });
      } catch (e) {
        return reply(200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String((e as Error)?.message || e) }], isError: true } });
      }
    }
    if (methodName === "resources/list") return reply(200, { jsonrpc: "2.0", id, result: { resources: [] } });
    if (methodName === "prompts/list") return reply(200, { jsonrpc: "2.0", id, result: { prompts: [] } });
    return reply(200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + methodName } });
  }

  function mcpCall(toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === "create_repo") {
      const name = String(args.name || "");
      if (store.getRepoByName(name)) throw new Error("Repository already exists: " + name);
      const repo = store.createRepo(name, String(args.description || ""));
      return repoJson(store, repo);
    }
    if (toolName === "list_repos") {
      return store.listRepos().map((r) => repoJson(store, r));
    }
    const { owner, repo: repoName } = mcpResolveOwnerRepo(args);
    const repo = store.findRepo(owner, repoName);
    if (!repo) throw new Error("Repository not found: " + owner + "/" + repoName);
    if (toolName === "get_repo") return repoJson(store, repo);
    if (toolName === "create_issue") {
      const ts = store.now();
      const issue: Issue = {
        id: store.nextIssueId++,
        number: ++repo.issueCounter,
        title: String(args.title || ""),
        body: String(args.body || ""),
        state: "open",
        labels: [],
        createdAt: ts,
        updatedAt: ts,
        tick: store.tick,
        userLogin: store.ownerLogin(repo),
      };
      repo.issues.push(issue);
      return issueJson(store, repo, issue);
    }
    if (toolName === "list_issues") {
      const state = String(args.state || "open");
      let list = [...repo.issues];
      if (state !== "all") list = list.filter((i) => i.state === state);
      return list.map((i) => issueJson(store, repo, i));
    }
    if (toolName === "get_issue") {
      const num = Number(args.issue_number ?? args.number ?? 0);
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) throw new Error("Issue not found: " + num);
      return issueJson(store, repo, issue);
    }
    if (toolName === "create_pull_request") {
      const headRef = String(args.head || "");
      const baseRef = String(args.base || repo.defaultBranch);
      const ts = store.now();
      const pr: Pull = {
        id: store.nextPullId++,
        number: ++repo.pullCounter,
        title: String(args.title || ""),
        body: String(args.body || ""),
        state: "open",
        headRef,
        headSha: headShaOf(repo, headRef),
        baseRef,
        baseSha: headShaOf(repo, baseRef),
        merged: false,
        mergeable: true,
        mergeSha: "",
        createdAt: ts,
        updatedAt: ts,
        tick: store.tick,
        userLogin: store.ownerLogin(repo),
      };
      repo.pulls.push(pr);
      return pullJson(store, repo, pr);
    }
    if (toolName === "merge_pull_request") {
      const num = Number(args.pull_number ?? args.number ?? 0);
      const pr = repo.pulls.find((p) => p.number === num);
      if (!pr) throw new Error("Pull request not found: " + num);
      if (pr.state !== "open") throw new Error("Pull request is not open");
      const headSha = pr.headSha || headShaOf(repo, pr.headRef);
      const baseSha = pr.baseSha || headShaOf(repo, pr.baseRef);
      const headObj = repo.objects.get(headSha);
      if (!headObj || headObj.type !== "commit") throw new Error("Pull request cannot be merged");
      const headTree = parseCommit(headObj.data).tree;
      const mergeSha = makeCommit(repo, headTree, [baseSha], "Merge pull request #" + pr.number + " from " + pr.headRef);
      repo.branches.set(pr.baseRef, mergeSha);
      repo.packCache.clear();
      pr.state = "closed";
      pr.merged = true;
      pr.mergeSha = mergeSha;
      pr.updatedAt = store.stamp();
      return { sha: mergeSha, merged: true, message: "Pull request successfully merged" };
    }
    throw new Error("Unknown tool: " + toolName);
  }

  return server;
}
void createHash;
void deflateSync;
