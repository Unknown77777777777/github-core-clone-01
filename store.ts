import { createHash } from "node:crypto";

export type ObjType = "blob" | "tree" | "commit" | "tag";

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  tick: number;
  userLogin: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergeable: boolean;
  mergeSha: string;
  createdAt: string;
  updatedAt: string;
  tick: number;
  userLogin: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  defaultBranch: string;
  branches: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  issueCounter: number;
  pullCounter: number;
  createdAt: string;
  updatedAt: string;
  packCache: Map<string, Buffer>;
}

export function sha1Of(type: string, data: Buffer): string {
  const h = createHash("sha1");
  h.update(type + " " + data.length + "\0");
  h.update(data);
  return h.digest("hex");
}

export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const sha = sha1Of(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export class Store {
  reposByName = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextLabelId = 1;
  tick = 0;
  baseMs: number;

  constructor() {
    const raw = process.env.MAKEFUN_TRIAL_NOW || "";
    const parsed = raw ? Date.parse(raw) : NaN;
    this.baseMs = Number.isFinite(parsed) ? parsed : Date.parse("2026-11-20T00:00:00.000Z");
  }

  now(): string {
    this.tick += 1;
    return new Date(this.baseMs + this.tick * 1000).toISOString();
  }

  // Deterministic timestamp without advancing the clock (for updated fields
  // that should mirror created time).
  stamp(): string {
    return new Date(this.baseMs + this.tick * 1000).toISOString();
  }

  tokenLogin(): string {
    const tok = process.env.MAKEFUN_SHOP_TOKEN || "";
    // If the token is a JWT with a login claim, use it; otherwise empty
    // (owner is bound lazily from the first owner-scoped request).
    const parts = tok.split(".");
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
        const login = payload.login || payload.username || payload.sub;
        if (typeof login === "string" && login) return login;
      } catch {
        // not a JWT, ignore
      }
    }
    return "";
  }

  createRepo(name: string, description: string): Repo {
    const login = this.tokenLogin();
    const ts = this.now();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: login,
      description,
      defaultBranch: "main",
      branches: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      issueCounter: 0,
      pullCounter: 0,
      createdAt: ts,
      updatedAt: ts,
      packCache: new Map(),
    };
    // Default labels, like a fresh GitHub repo. They exist before any label
    // creation call so issue creation with a standard label never 422s.
    for (const [lname, color] of [
      ["bug", "d73a4a"],
      ["documentation", "0075ca"],
      ["duplicate", "cfd3d7"],
      ["enhancement", "a2eeef"],
      ["good first issue", "7057ff"],
      ["help wanted", "008672"],
      ["invalid", "e4e669"],
      ["question", "d876e3"],
      ["wontfix", "ffffff"],
    ] as const) {
      repo.labels.set(lname, { id: this.nextLabelId++, name: lname, color, description: "" });
    }
    this.reposByName.set(name, repo);
    return repo;
  }

  findRepo(owner: string, name: string): Repo | null {
    const repo = this.reposByName.get(name);
    if (!repo) return null;
    if (!repo.owner) {
      repo.owner = owner;
    } else if (repo.owner !== owner) {
      return null;
    }
    return repo;
  }

  getRepoByName(name: string): Repo | null {
    return this.reposByName.get(name) || null;
  }

  listRepos(): Repo[] {
    return [...this.reposByName.values()].sort((a, b) => a.id - b.id);
  }

  deleteRepo(name: string): boolean {
    return this.reposByName.delete(name);
  }

  ownerLogin(repo: Repo): string {
    return repo.owner || "owner";
  }

  fullName(repo: Repo): string {
    return this.ownerLogin(repo) + "/" + repo.name;
  }
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.ownerLogin(repo);
  const base = "https://api.github.com/repos/" + owner + "/" + repo.name;
  const head = repo.branches.get(repo.defaultBranch) || "";
  return {
    id: repo.id,
    node_id: "R_" + repo.id,
    name: repo.name,
    full_name: owner + "/" + repo.name,
    owner: { login: owner, id: repo.id, node_id: "U_" + repo.id, type: "User", site_admin: false },
    private: false,
    html_url: "https://github.com/" + owner + "/" + repo.name,
    description: repo.description || null,
    fork: false,
    url: base,
    archive_url: base + "/{archive_format}{/ref}",
    assignees_url: base + "/assignees{/user}",
    blobs_url: base + "/git/blobs{/sha}",
    branches_url: base + "/branches{/branch}",
    clone_url: "https://github.com/" + owner + "/" + repo.name + ".git",
    collaborators_url: base + "/collaborators{/collaborator}",
    comments_url: base + "/comments{/number}",
    commits_url: base + "/commits{/sha}",
    compare_url: base + "/compare/{base}...{head}",
    contents_url: base + "/contents/{+path}",
    contributors_url: base + "/contributors",
    deployments_url: base + "/deployments",
    downloads_url: base + "/downloads",
    events_url: base + "/events",
    forks_url: base + "/forks",
    git_commits_url: base + "/git/commits{/sha}",
    git_refs_url: base + "/git/refs{/sha}",
    git_tags_url: base + "/git/tags{/sha}",
    git_url: "git://github.com/" + owner + "/" + repo.name + ".git",
    issue_comment_url: base + "/issues/comments{/number}",
    issue_events_url: base + "/issues/events{/number}",
    issues_url: base + "/issues{/number}",
    keys_url: base + "/keys{/key_id}",
    labels_url: base + "/labels{/name}",
    languages_url: base + "/languages",
    merges_url: base + "/merges",
    milestones_url: base + "/milestones{/number}",
    notifications_url: base + "/notifications{?since,all,participating}",
    pulls_url: base + "/pulls{/number}",
    releases_url: base + "/releases{/id}",
    ssh_url: "git@github.com:" + owner + "/" + repo.name + ".git",
    stargazers_url: base + "/stargazers",
    statuses_url: base + "/statuses/{sha}",
    subscribers_url: base + "/subscribers",
    subscription_url: base + "/subscription",
    tags_url: base + "/tags",
    teams_url: base + "/teams",
    trees_url: base + "/git/trees{/sha}",
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    default_branch: repo.defaultBranch,
    open_issues_count: repo.issues.filter((i) => i.state === "open").length,
    is_template: false,
    topics: [],
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: "public",
    pushed_at: repo.updatedAt,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_rebase_merge: true,
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_forking: true,
    subscribers_count: 0,
    network_count: 0,
    license: null,
    headSha: head,
  };
}

export function labelJson(store: Store, repo: Repo, label: Label): Record<string, unknown> {
  const owner = store.ownerLogin(repo);
  return {
    id: label.id,
    node_id: "L_" + label.id,
    url: "https://api.github.com/repos/" + owner + "/" + repo.name + "/labels/" + encodeURIComponent(label.name),
    name: label.name,
    description: label.description || null,
    color: label.color,
    default: false,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = store.ownerLogin(repo);
  const base = "https://api.github.com/repos/" + owner + "/" + repo.name;
  return {
    id: issue.id,
    node_id: "I_" + issue.id,
    url: base + "/issues/" + issue.number,
    repository_url: base,
    labels_url: base + "/issues/" + issue.number + "/labels{/name}",
    comments_url: base + "/issues/" + issue.number + "/comments",
    events_url: base + "/issues/" + issue.number + "/events",
    html_url: "https://github.com/" + owner + "/" + repo.name + "/issues/" + issue.number,
    number: issue.number,
    state: issue.state,
    state_reason: null,
    title: issue.title,
    body: issue.body || null,
    user: { login: issue.userLogin, id: repo.id, node_id: "U_" + repo.id, type: "User", site_admin: false },
    labels: issue.labels.map((n) => {
      const l = repo.labels.get(n);
      return l ? labelJson(store, repo, l) : { name: n, color: "ededed", description: null };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: 0,
    pull_request: undefined,
    closed_at: issue.state === "closed" ? issue.updatedAt : null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    author_association: "OWNER",
    type: null,
  };
}

export function pullJson(store: Store, repo: Repo, pr: Pull): Record<string, unknown> {
  const owner = store.ownerLogin(repo);
  const base = "https://api.github.com/repos/" + owner + "/" + repo.name;
  const headSha = pr.headSha || repo.branches.get(pr.headRef) || "";
  const baseSha = pr.baseSha || repo.branches.get(pr.baseRef) || "";
  return {
    id: pr.id,
    node_id: "PR_" + pr.id,
    url: base + "/pulls/" + pr.number,
    html_url: "https://github.com/" + owner + "/" + repo.name + "/pull/" + pr.number,
    diff_url: base + "/pulls/" + pr.number + ".diff",
    patch_url: base + "/pulls/" + pr.number + ".patch",
    issue_url: base + "/issues/" + pr.number,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    body: pr.body || null,
    user: { login: pr.userLogin, id: repo.id, node_id: "U_" + repo.id, type: "User", site_admin: false },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === "closed" ? pr.updatedAt : null,
    merged_at: pr.merged ? pr.updatedAt : null,
    merge_commit_sha: pr.mergeSha || null,
    mergeable: pr.mergeable,
    mergeable_state: pr.mergeable ? "clean" : "dirty",
    merged: pr.merged,
    merged_by: pr.merged ? { login: pr.userLogin, id: repo.id, type: "User" } : null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    head: {
      label: owner + ":" + pr.headRef,
      ref: pr.headRef,
      sha: headSha,
      user: { login: owner, id: repo.id, type: "User" },
      repo: repoJson(store, repo),
    },
    base: {
      label: owner + ":" + pr.baseRef,
      ref: pr.baseRef,
      sha: baseSha,
      user: { login: owner, id: repo.id, type: "User" },
      repo: repoJson(store, repo),
    },
    _links: {
      self: { href: base + "/pulls/" + pr.number },
      html: { href: "https://github.com/" + owner + "/" + repo.name + "/pull/" + pr.number },
    },
    author_association: "OWNER",
  };
}
