// github-core-clone-01 — HTTP server: git smart HTTP + REST v3 + GraphQL v4 + MCP.
// One process, no dependencies, Node 22+ (uses --experimental-strip-types locally).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { VIEWER } from './scenario.ts';
import * as git from './git.ts';
import {
  Store,
  type Repo,
  type Issue,
  type Pull,
  type Comment,
  type Label,
  commitHistory,
  isAncestor,
  mergeBase,
  diffFiles,
  flattenTree,
  buildTreeFromPaths,
  setPathInTree,
  removePathFromTree,
  blobOid,
  makeCommit,
  nextSeq,
  FIXED_TIME,
} from './store.ts';

const AGENT = 'github-core-clone/1.0';
const store = new Store();
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': randomUUID(),
    'Content-Length': data.length,
  });
  res.end(data);
}

function sendStatus(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const v: unknown = JSON.parse(body.toString('utf8'));
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7);
}

function authed(req: IncomingMessage): boolean {
  const t = bearer(req);
  if (t === null) return false;
  if (TOKEN === '') return t.length > 0;
  return t === TOKEN;
}

function absUrl(req: IncomingMessage, url: URL): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}${url.pathname}${url.search}`;
}

function pageParams(url: URL): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  return { perPage, page };
}

function paginate<T>(items: T[], url: URL, req: IncomingMessage): { slice: T[]; link: string | null } {
  const { perPage, page } = pageParams(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(url.toString());
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    link = `<${absUrl(req, next)}>; rel="next"`;
  }
  return { slice, link };
}

function sendList<T>(res: ServerResponse, items: T[], url: URL, req: IncomingMessage): void {
  const { slice, link } = paginate(items, url, req);
  const data = Buffer.from(JSON.stringify(slice));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': randomUUID(),
    'Content-Length': String(data.length),
  };
  if (link) headers.Link = link;
  res.writeHead(200, headers);
  res.end(data);
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------
function findRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function getRepoById(id: number): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return null;
}

function commitView(repo: Repo, oid: string): { tree: string; parents: string[]; message: string } | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  try {
    return git.parseCommit(obj.data);
  } catch {
    return null;
  }
}

/** Walk a tree to a path; returns {type, oid} or null. Empty path = the tree itself. */
function getPathEntry(repo: Repo, treeOid: string, path: string): { type: 'blob' | 'tree'; oid: string } | null {
  if (path === '') return { type: 'tree', oid: treeOid };
  const parts = path.split('/');
  let current = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    let found: { mode: string; oid: string } | null = null;
    for (const entry of git.parseTree(obj.data)) {
      if (entry.name === parts[i]) { found = entry; break; }
    }
    if (!found) return null;
    if (i === parts.length - 1) {
      return { type: found.mode === '40000' ? 'tree' : 'blob', oid: found.oid };
    }
    if (found.mode !== '40000') return null;
    current = found.oid;
  }
  return null;
}

/** Create a commit on a branch that sets (content != null) or removes (content == null) a file. */
function commitOnBranch(repo: Repo, branch: string, path: string, content: Buffer | null, message: string): string | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined && branch !== repo.defaultBranch) return null;
  const baseTree = tip ? commitView(repo, tip)?.tree ?? null : null;
  let treeOid: string;
  if (content === null) {
    if (baseTree === null) return null;
    treeOid = removePathFromTree(repo, baseTree, path);
  } else {
    const blob = blobOid(repo, content);
    treeOid = setPathInTree(repo, baseTree, path, blob);
  }
  const commitOid = makeCommit(repo, treeOid, tip ? [tip] : [], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

// ---------------------------------------------------------------------------
// JSON views
// ---------------------------------------------------------------------------
function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: Buffer.from(`User:${id}`).toString('base64'),
    avatar_url: 'https://example.invalid/avatar.png',
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
    name: login,
    email: `${login}@example.invalid`,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  const owner = userJson(VIEWER.login, VIEWER.id);
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner,
    private: repo.isPrivate,
    html_url: `https://github.com/${VIEWER.login}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}`,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    pushed_at: FIXED_TIME,
    git_url: `git://github.com/${VIEWER.login}/${repo.name}.git`,
    ssh_url: `git@github.com:${VIEWER.login}/${repo.name}.git`,
    clone_url: `https://github.com/${VIEWER.login}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((i) => i.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  const index = [...repo.labels.keys()].indexOf(label.name);
  return {
    id: repo.id * 1000 + Math.max(0, index) + 1,
    node_id: Buffer.from(`Label:${repo.id}:${label.name}`).toString('base64'),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: '',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${VIEWER.login}/${repo.name}`,
    labels_url: '',
    comments_url: '',
    events_url: '',
    html_url: `https://github.com/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(VIEWER.login, VIEWER.id),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(repo, label) : { name, color: 'ededed' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: issue.state === 'closed' ? FIXED_TIME : null,
    author_association: 'OWNER',
    active_lock_reason: null,
    state_reason: null,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${VIEWER.login}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(VIEWER.login, VIEWER.id),
    body: pull.body,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: pull.state === 'closed' ? FIXED_TIME : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: isMergeable(repo, pull),
    mergeable_state: 'clean',
    merged_by: null,
    head: {
      label: `${VIEWER.login}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(VIEWER.login, VIEWER.id),
      repo: repoJson(repo),
    },
    base: {
      label: `${VIEWER.login}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(VIEWER.login, VIEWER.id),
      repo: repoJson(repo),
    },
    _links: {},
    author_association: 'OWNER',
    auto_merge: null,
    draft: false,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.id}:${issue.number}:${comment.id}`).toString('base64'),
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${VIEWER.login}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------------------
// Merge logic (shared by REST + GraphQL)
// ---------------------------------------------------------------------------
/** The current tip of the PR's base branch (moves as the base advances). */
function baseTipSha(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
}

function conflictPaths(repo: Repo, pull: Pull): string[] {
  const baseTip = baseTipSha(repo, pull);
  const mb = mergeBase(repo, pull.headSha, baseTip);
  if (mb === null) return [];
  const headView = commitView(repo, pull.headSha);
  const baseView = commitView(repo, baseTip);
  const mbView = commitView(repo, mb);
  if (!headView || !baseView || !mbView) return [];
  const headFiles = flattenTree(repo, headView.tree);
  const baseFiles = flattenTree(repo, baseView.tree);
  const mbFiles = flattenTree(repo, mbView.tree);
  const conflicts: string[] = [];
  const all = new Set([...headFiles.keys(), ...mbFiles.keys()]);
  for (const path of all) {
    const head = headFiles.get(path)?.oid ?? null;
    const mbv = mbFiles.get(path)?.oid ?? null;
    const base = baseFiles.get(path)?.oid ?? null;
    const headChanged = head !== mbv;
    const baseChanged = base !== mbv;
    const sameResult = head === base;
    if (headChanged && baseChanged && !sameResult) conflicts.push(path);
  }
  return conflicts;
}

function isMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  return conflictPaths(repo, pull).length === 0;
}

function doMerge(repo: Repo, pull: Pull, method: string): { ok: boolean; sha?: string; message?: string } {
  if (pull.state !== 'open') return { ok: false, message: 'Pull request is already closed' };
  const conflicts = conflictPaths(repo, pull);
  if (conflicts.length > 0) return { ok: false, message: 'Merge conflict' };
  const baseTip = baseTipSha(repo, pull);
  const mb = mergeBase(repo, pull.headSha, baseTip);
  const headView = commitView(repo, pull.headSha);
  const baseView = commitView(repo, baseTip);
  if (!headView || !baseView) return { ok: false, message: 'Missing commit' };
  const headFiles = flattenTree(repo, headView.tree);
  const baseFiles = flattenTree(repo, baseView.tree);
  const mbFiles = mb ? flattenTree(repo, commitView(repo, mb)?.tree ?? '') : new Map<string, { mode: string; oid: string }>();
  const merged = new Map<string, { mode: string; oid: string }>(baseFiles);
  for (const [path, file] of headFiles) {
    const mbv = mbFiles.get(path)?.oid ?? null;
    if (mbv !== file.oid) merged.set(path, file);
  }
  for (const path of mbFiles.keys()) {
    if (!headFiles.has(path)) merged.delete(path);
  }
  const treeOid = buildTreeFromPaths(repo, merged);
  const message = method === 'squash'
    ? `${pull.title} (#${pull.number})`
    : `Merge pull request #${pull.number} from ${pull.headRef}`;
  const commitOid = makeCommit(repo, treeOid, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TIME;
  pull.mergeCommitSha = commitOid;
  return { ok: true, sha: commitOid };
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------
function refLine(oid: string, name: string, caps: string | null): string {
  return caps ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`;
}

function v0Advertise(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const lines: Buffer[] = [];
  lines.push(git.encodePktLine(`# service=git-${service}\n`));
  lines.push(git.pktFlush());
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const caps = service === 'upload-pack'
    ? 'side-band-64k thin-pack ofs-delta multi_ack shallow agent=github-core-clone/1.0'
    : `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=github-core-clone/1.0`;
  if (refs.length === 0) {
    lines.push(git.encodePktLine(refLine(git.ZERO_OID, 'HEAD', caps)));
  } else {
    let first = true;
    for (const [name, oid] of refs) {
      if (first && name === `refs/heads/${repo.defaultBranch}`) {
        lines.push(git.encodePktLine(refLine(oid, 'HEAD', caps)));
        lines.push(git.encodePktLine(refLine(oid, name, null)));
        first = false;
        continue;
      }
      lines.push(git.encodePktLine(refLine(oid, name, first ? caps : null)));
      first = false;
    }
    for (const [name, oid] of refs) {
      if (name.startsWith('refs/tags/')) {
        const obj = repo.objects.get(oid);
        if (obj?.type === 'tag') {
          const tag = git.parseTag(obj.data);
          lines.push(git.encodePktLine(`${tag.object} ${name}^{}\n`));
        }
      }
    }
  }
  lines.push(git.pktFlush());
  return Buffer.concat(lines);
}

function v2Advertise(repo: Repo): Buffer {
  const lines: Buffer[] = [];
  lines.push(git.encodePktLine('# service=git-upload-pack\n'));
  lines.push(git.pktFlush());
  lines.push(git.encodePktLine('version 2\n'));
  lines.push(git.encodePktLine('ls-refs=unborn\n'));
  lines.push(git.encodePktLine('fetch=shallow filter\n'));
  lines.push(git.encodePktLine('object-format=sha1\n'));
  lines.push(git.encodePktLine(`agent=${AGENT}\n`));
  lines.push(git.pktFlush());
  return Buffer.concat(lines);
}

interface FetchPlan {
  send: Set<string>;
  shallowOut: string[];
  unshallowOut: string[];
}

function treeOids(repo: Repo, rootTree: string): Set<string> {
  const out = new Set<string>([rootTree]);
  const stack = [rootTree];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') continue;
    for (const entry of git.parseTree(obj.data)) {
      if (entry.mode === '40000' && !out.has(entry.oid)) { out.add(entry.oid); stack.push(entry.oid); }
    }
  }
  return out;
}

function planFetch(repo: Repo, wants: string[], haves: string[], shallowBoundaries: Set<string>, depth?: number): FetchPlan {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  const tagTargets = new Map<string, string>();
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const tag = git.parseTag(obj.data);
      tagTargets.set(want, tag.object);
      if (!dist.has(tag.object)) { dist.set(tag.object, 0); queue.push(tag.object); }
    } else if (obj.type === 'commit') {
      if (!dist.has(want)) { dist.set(want, 0); queue.push(want); }
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const oid = queue[i];
    const d = dist.get(oid)!;
    // Parents would sit at distance d+1; with a depth limit they can only matter when d+1 < depth.
    if (depth !== undefined && d + 1 >= depth) continue;
    const view = commitView(repo, oid);
    if (!view) continue;
    for (const parent of view.parents) {
      if (!dist.has(parent) && repo.objects.has(parent)) {
        dist.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  const included = new Set<string>();
  for (const [oid, d] of dist) {
    if (depth === undefined || d < depth) included.add(oid);
  }
  const send = new Set<string>();
  for (const oid of included) {
    const view = commitView(repo, oid);
    if (!view) continue;
    send.add(oid);
    for (const file of flattenTree(repo, view.tree).values()) send.add(file.oid);
    for (const tree of treeOids(repo, view.tree)) send.add(tree);
  }
  for (const tagOid of tagTargets.keys()) send.add(tagOid);

  // Held objects: reachable from haves, not descending past shallow boundaries.
  const held = new Set<string>();
  const hq: string[] = [];
  for (const have of haves) {
    const obj = repo.objects.get(have);
    if (!obj) continue;
    if (obj.type === 'commit' && !held.has(have)) { held.add(have); hq.push(have); }
    if (obj.type === 'tag') {
      const tag = git.parseTag(obj.data);
      held.add(have);
      if (repo.objects.get(tag.object)?.type === 'commit' && !held.has(tag.object)) { held.add(tag.object); hq.push(tag.object); }
    }
  }
  for (let i = 0; i < hq.length; i++) {
    const oid = hq[i];
    if (shallowBoundaries.has(oid)) continue;
    const view = commitView(repo, oid);
    if (!view) continue;
    for (const parent of view.parents) {
      if (!held.has(parent) && repo.objects.has(parent)) { held.add(parent); hq.push(parent); }
    }
  }
  for (const oid of [...held]) {
    const view = commitView(repo, oid);
    if (!view) continue;
    for (const file of flattenTree(repo, view.tree).values()) held.add(file.oid);
    for (const tree of treeOids(repo, view.tree)) held.add(tree);
  }
  for (const oid of held) send.delete(oid);

  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (depth !== undefined) {
    for (const [oid, d] of dist) {
      if (d === depth - 1 && included.has(oid)) {
        const view = commitView(repo, oid);
        if (view && view.parents.length > 0) shallowOut.push(oid);
      }
    }
    for (const b of shallowBoundaries) {
      const d = dist.get(b);
      if (d !== undefined && d < depth - 1) unshallowOut.push(b);
    }
  }
  return { send, shallowOut, unshallowOut };
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string): void {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack') {
    const body = isV2 ? v2Advertise(repo) : v0Advertise(repo, 'upload-pack');
    res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
    res.end(body);
  } else if (service === 'git-receive-pack') {
    const body = v0Advertise(repo, 'receive-pack');
    res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-advertisement' });
    res.end(body);
  } else {
    sendStatus(res, 404, 'Not Found');
  }
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  try {
    const lines = git.pktLinesToText(git.decodePktLines(body)).map((l) => l.trim());
    if (isV2) {
      const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length).trim();
      const args = lines.filter((l) => !l.startsWith('command='));
      if (command === 'ls-refs') {
        const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length).trim());
        const wantPeel = args.some((a) => a === 'peel');
        const wantSymrefs = args.some((a) => a === 'symrefs');
        const out: Buffer[] = [];
        const entries: { oid: string; name: string; symref?: string; peel?: string; unborn?: boolean }[] = [];
        const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
        entries.push({
          oid: headTip ?? git.ZERO_OID,
          name: 'HEAD',
          symref: `refs/heads/${repo.defaultBranch}`,
          unborn: headTip === null,
        });
        const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
        for (const [name, oid] of refs) {
          let peel: string | undefined;
          const obj = repo.objects.get(oid);
          if (obj?.type === 'tag') peel = git.parseTag(obj.data).object;
          entries.push({ oid, name, peel });
        }
        if (headTip === null) {
          // An empty repo advertises only the unborn HEAD; a refs/heads/main entry here would
          // make a fresh repo look non-empty to ls-refs.
        }
        for (const e of entries) {
          if (prefixes.length > 0 && !prefixes.some((p) => e.name.startsWith(p))) continue;
          let line: string;
          if (e.unborn) {
            line = `unborn ${e.name} symref-target:${e.symref}`;
          } else {
            line = `${e.oid} ${e.name}`;
            if (wantSymrefs && e.symref) line += ` symref-target:${e.symref}`;
            if (wantPeel && e.peel) line += ` peeled:${e.peel}`;
          }
          out.push(git.encodePktLine(line + '\n'));
        }
        out.push(git.pktFlush());
        res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
        res.end(Buffer.concat(out));
        return;
      }
      if (command === 'fetch') {
        const wants: string[] = [];
        const haves: string[] = [];
        const shallow: string[] = [];
        let depth: number | undefined;
        for (const a of args) {
          if (a.startsWith('want ')) wants.push(a.slice(5).trim());
          else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
          else if (a.startsWith('shallow ')) shallow.push(a.slice(8).trim());
          else if (a.startsWith('deepen ')) depth = Number(a.slice(7).trim());
        }
        const plan = planFetch(repo, wants, haves, new Set(shallow), depth);
        const out: Buffer[] = [];
        if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
          out.push(git.encodePktLine('shallow-info\n'));
          for (const oid of plan.shallowOut) out.push(git.encodePktLine(`shallow ${oid}\n`));
          for (const oid of plan.unshallowOut) out.push(git.encodePktLine(`unshallow ${oid}\n`));
          out.push(git.pktFlush());
        }
        out.push(git.encodePktLine('packfile\n'));
        const pack = git.writePack([...plan.send].map((oid) => repo.objects.get(oid)!).filter(Boolean));
        out.push(git.sidebandPack(pack));
        out.push(git.pktFlush());
        res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
        res.end(Buffer.concat(out));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
      res.end(git.pktFlush());
      return;
    }
    // v0 upload-pack
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    for (const line of lines) {
      if (line === 'done') break;
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const nul = rest.indexOf('\0');
        wants.push((nul >= 0 ? rest.slice(0, nul) : rest).trim());
      } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    }
    const plan = planFetch(repo, wants, haves, new Set(shallow), depth);
    const out: Buffer[] = [];
    if (haves.length === 0) {
      out.push(git.encodePktLine('NAK\n'));
    } else {
      for (const have of haves) {
        if (repo.objects.has(have)) out.push(git.encodePktLine(`ACK ${have}\n`));
      }
      out.push(git.encodePktLine('NAK\n'));
    }
    for (const oid of plan.shallowOut) out.push(git.encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowOut) out.push(git.encodePktLine(`unshallow ${oid}\n`));
    const pack = git.writePack([...plan.send].map((oid) => repo.objects.get(oid)!).filter(Boolean));
    out.push(git.sidebandPack(pack));
    out.push(git.pktFlush());
    res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
    res.end(Buffer.concat(out));
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
    res.end(git.pktFlush());
  }
}

function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  try {
    const lines: string[] = [];
    let offset = 0;
    let packStart = -1;
    while (offset + 4 <= body.length) {
      const len = parseInt(body.toString('ascii', offset, offset + 4), 16);
      if (Number.isNaN(len)) break;
      if (len === 0) { offset += 4; packStart = offset; break; }
      if (len < 4 || offset + len > body.length) break;
      lines.push(body.toString('utf8', offset + 4, offset + len));
      offset += len;
    }
    const commands: { old: string; new: string; ref: string }[] = [];
    for (const line of lines) {
      // The first command line carries capabilities after NUL: "<old> <new> <ref>\0report-status ...".
      const clean = line.split('\0')[0].trim();
      const parts = clean.split(' ');
      if (parts.length === 3) commands.push({ old: parts[0], new: parts[1], ref: parts[2] });
    }
    const pack = packStart >= 0 ? body.subarray(packStart) : Buffer.alloc(0);
    if (pack.length > 0) {
      const objects = git.readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    }
    const results: { ref: string; ok: boolean; reason?: string }[] = [];
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref) ?? null;
      if (cmd.new === git.ZERO_OID) {
        if (current === null) {
          results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
        } else if (current !== cmd.old) {
          results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
        } else {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true });
        }
        continue;
      }
      if (!repo.objects.has(cmd.new)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (cmd.old === git.ZERO_OID) {
        if (current !== null) {
          results.push({ ref: cmd.ref, ok: false, reason: 'ref already exists' });
        } else {
          repo.refs.set(cmd.ref, cmd.new);
          results.push({ ref: cmd.ref, ok: true });
        }
        continue;
      }
      if (current !== cmd.old) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
        continue;
      }
      if (!isAncestor(repo, cmd.old, cmd.new)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.new);
      results.push({ ref: cmd.ref, ok: true });
    }
    const reportLines: Buffer[] = [git.encodePktLine('unpack ok\n')];
    for (const r of results) {
      reportLines.push(git.encodePktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? 'failed'}\n`));
    }
    const out = Buffer.concat([git.sidebandPack(Buffer.concat(reportLines)), git.pktFlush()]);
    res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result' });
    res.end(out);
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result' });
    res.end(git.pktFlush());
  }
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------
async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const seg = path.split('/').filter((s) => s.length > 0);

  // GET /api/v3/ — API root
  if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'v3' && method === 'GET') {
    const data = Buffer.from(JSON.stringify({
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
      meta: '/api/v3/meta',
    }));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-GitHub-Request-Id': randomUUID(),
      'X-OAuth-Scopes': 'repo, read:org',
      'Content-Length': data.length,
    });
    res.end(data);
    return;
  }

  // GET /api/v3/meta
  if (seg.length === 3 && seg[2] === 'meta' && method === 'GET') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_services_sha: 'abc123' });
    return;
  }

  // GET /api/v3/user
  if (seg.length === 3 && seg[2] === 'user' && method === 'GET') {
    sendJson(res, 200, userJson(VIEWER.login, VIEWER.id));
    return;
  }

  // /api/v3/user/repos
  if (seg.length === 4 && seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'GET') {
      sendList(res, store.listRepos(VIEWER.login).map((r) => repoJson(r)), url, req);
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null) { sendStatus(res, 400, 'Invalid JSON'); return; }
      const name = String(parsed.name ?? '');
      if (!name) { sendStatus(res, 422, 'Repository name is required'); return; }
      const repo = store.createRepo(VIEWER.login, name, Boolean(parsed.private ?? false), typeof parsed.description === 'string' ? parsed.description : '');
      if (repo === null) { sendStatus(res, 422, 'Repository already exists'); return; }
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }

  // /api/v3/repos/:owner/:repo[/...]
  if (seg.length >= 4 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'repos') {
    const owner = seg[3];
    const name = seg[4];
    const repo = findRepo(owner, name);
    const rest = seg.slice(5);
    if (repo === null) { sendStatus(res, 404, 'Not Found'); return; }

    // /repos/:o/:r
    if (rest.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (parsed === null) { sendStatus(res, 400, 'Invalid JSON'); return; }
        if (typeof parsed.description === 'string') repo.description = parsed.description;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        res.writeHead(204, { 'X-GitHub-Request-Id': randomUUID() });
        res.end();
        return;
      }
      sendStatus(res, 404, 'Not Found');
      return;
    }

    // /repos/:o/:r/branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([n]) => n.startsWith('refs/heads/'))
          .map(([n, oid]) => ({
            name: n.slice('refs/heads/'.length),
            commit: { sha: oid, url: `/api/v3/repos/${owner}/${name}/commits/${oid}` },
            protected: false,
          }));
        sendList(res, branches, url, req);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const oid = repo.refs.get(`refs/heads/${rest[1]}`);
        if (oid === undefined) { sendStatus(res, 404, 'Not Found'); return; }
        sendJson(res, 200, {
          name: rest[1],
          commit: { sha: oid, url: `/api/v3/repos/${owner}/${name}/commits/${oid}` },
          protected: false,
        });
        return;
      }
      sendStatus(res, 404, 'Not Found');
      return;
    }

    // /repos/:o/:r/git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const parsed = parseJsonBody(body);
        if (parsed === null) { sendStatus(res, 400, 'Invalid JSON'); return; }
        const ref = String(parsed.ref ?? '');
        const sha = String(parsed.sha ?? '');
        if (!ref.startsWith('refs/') || !repo.objects.has(sha) || repo.refs.has(ref)) {
          sendStatus(res, 422, 'Invalid ref or sha');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, {
          ref,
          node_id: Buffer.from(`Ref:${ref}`).toString('base64'),
          url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace('refs/', '')}`,
          object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' },
        });
        return;
      }
      if (method === 'GET' && rest.length >= 3) {
        const refName = `refs/${rest.slice(2).join('/')}`;
        const oid = repo.refs.get(refName);
        if (oid === undefined) { sendStatus(res, 404, 'Not Found'); return; }
        sendJson(res, 200, {
          ref: refName,
          node_id: Buffer.from(`Ref:${refName}`).toString('base64'),
          url: `/api/v3/repos/${owner}/${name}/git/refs/${refName.replace('refs/', '')}`,
          object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: '' },
        });
        return;
      }
      sendStatus(res, 404, 'Not Found');
      return;
    }

    // /repos/:o/:r/commits
    if (rest[0] === 'commits' && method === 'GET') {
      const shaParam = url.searchParams.get('sha');
      const ref = shaParam ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${ref}`) ?? (repo.objects.has(ref) ? ref : undefined);
      if (tip === undefined) { sendJson(res, 200, []); return; }
      const commits = commitHistory(repo, tip).map((oid) => {
        const view = commitView(repo, oid);
        return {
          sha: oid,
          node_id: Buffer.from(`Commit:${oid}`).toString('base64'),
          commit: {
            message: view?.message ?? '',
            author: { name: 'Conformance', email: 'conformance@make.fun', date: FIXED_TIME },
            committer: { name: 'Conformance', email: 'conformance@make.fun', date: FIXED_TIME },
            tree: { sha: view?.tree ?? '' },
          },
          author: userJson(VIEWER.login, VIEWER.id),
          committer: userJson(VIEWER.login, VIEWER.id),
          parents: (view?.parents ?? []).map((p) => ({ sha: p })),
        };
      });
      sendList(res, commits, url, req);
      return;
    }

    // /repos/:o/:r/contents/:path...
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      const refParam = url.searchParams.get('ref');
      const tip = refParam
        ? (repo.refs.get(`refs/heads/${refParam}`) ?? (repo.objects.has(refParam) ? refParam : undefined))
        : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (method === 'GET') {
        if (tip === undefined) { sendStatus(res, 404, 'Not Found'); return; }
        const view = commitView(repo, tip);
        if (!view) { sendStatus(res, 404, 'Not Found'); return; }
        const entry = getPathEntry(repo, view.tree, contentPath);
        if (entry === null) { sendStatus(res, 404, 'Not Found'); return; }
        if (entry.type === 'blob') {
          const blob = repo.objects.get(entry.oid);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: blob?.data.length ?? 0,
            name: contentPath.split('/').pop(),
            path: contentPath,
            sha: entry.oid,
            content: (blob?.data ?? Buffer.alloc(0)).toString('base64'),
            url: `/api/v3/repos/${owner}/${name}/contents/${contentPath}`,
            html_url: `https://github.com/${owner}/${name}/blob/${repo.defaultBranch}/${contentPath}`,
            download_url: '',
            _links: {},
          });
          return;
        }
        const treeObj = repo.objects.get(entry.oid);
        const tree = treeObj ? git.parseTree(treeObj.data) : [];
        const listing = tree.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: contentPath === '' ? e.name : `${contentPath}/${e.name}`,
          sha: e.oid,
          size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
          url: `/api/v3/repos/${owner}/${name}/contents/${contentPath === '' ? e.name : `${contentPath}/${e.name}`}`,
          html_url: '',
          download_url: '',
          _links: {},
        }));
        sendJson(res, 200, listing);
        return;
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(body);
        if (parsed === null) { sendStatus(res, 400, 'Invalid JSON'); return; }
        const branch = typeof parsed.branch === 'string' ? parsed.branch : repo.defaultBranch;
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        const contentB64 = typeof parsed.content === 'string' ? parsed.content : '';
        let contentBuf: Buffer;
        try { contentBuf = Buffer.from(contentB64, 'base64'); } catch { sendStatus(res, 400, 'Invalid content'); return; }
        if (branchTip === undefined && branch !== repo.defaultBranch) { sendStatus(res, 404, 'Not Found'); return; }
        const currentEntry = branchTip ? getPathEntry(repo, commitView(repo, branchTip)?.tree ?? '', contentPath) : null;
        if (typeof parsed.sha === 'string') {
          if (currentEntry === null || currentEntry.type !== 'blob' || currentEntry.oid !== parsed.sha) {
            sendStatus(res, 409, 'Conflict');
            return;
          }
        }
        const isCreate = currentEntry === null;
        const commitOid = commitOnBranch(repo, branch, contentPath, contentBuf, String(parsed.message ?? 'Update file'));
        if (commitOid === null) { sendStatus(res, 404, 'Not Found'); return; }
        const blob = blobOid(repo, contentBuf);
        sendJson(res, isCreate ? 201 : 200, {
          content: {
            name: contentPath.split('/').pop(),
            path: contentPath,
            sha: blob,
            size: contentBuf.length,
            encoding: 'base64',
            type: 'file',
            url: `/api/v3/repos/${owner}/${name}/contents/${contentPath}`,
          },
          commit: { sha: commitOid, message: String(parsed.message ?? 'Update file') },
        });
        return;
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(body);
        if (parsed === null) { sendStatus(res, 400, 'Invalid JSON'); return; }
        const branch = typeof parsed.branch === 'string' ? parsed.branch : repo.defaultBranch;
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        if (branchTip === undefined) { sendStatus(res, 404, 'Not Found'); return; }
        const currentEntry = getPathEntry(repo, commitView(repo, branchTip)?.tree ?? '', contentPath);
        if (currentEntry === null || currentEntry.type !== 'blob') { sendStatus(res, 404, 'Not Found'); return; }
        if (typeof parsed.sha === 'string' && currentEntry.oid !== parsed.sha) { sendStatus(res, 409, 'Conflict'); return; }
        const commitOid = commitOnBranch(repo, branch, contentPath, null, String(parsed.message ?? 'Delete file'));
        if (commitOid === null) { sendStatus(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { commit: { sha: commitOid, message: String(parsed.message ?? 'Delete file') } });
        return;
      }
      sendStatus(res, 404, 'Not Found');
      return;
    }

    // /repos/:o/:r/labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseJsonBody(body);
        if (parsed === null) { sendStatus(res, 400, 'Invalid JSON'); return; }
        const name = String(parsed.name ?? '');
        if (!name) { sendStatus(res, 422, 'Label name is required'); return; }
        const existing = repo.labels.get(name);
        if (existing) { sendJson(res, 200, labelJson(repo, existing)); return; }
        const label: Label = { name, color: String(parsed.color ?? 'ededed') };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(repo, label));
        return;
      }
      if (method === 'GET' && rest.length === 1) {
        sendList(res, [...repo.labels.values()].map((l) => labelJson(repo, l)), url, req);
        return;
      }
      sendStatus(res, 404, 'Not Found');
      return;
    }

    // /repos/:o/:r/issues[/:n[/comments]]
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const sort = url.searchParams.get('sort') ?? 'created';
          const direction = url.searchParams.get('direction') ?? 'desc';
          let issues = repo.issues.filter((i) => state === 'all' || i.state === state);
          if (sort === 'created') {
            issues = [...issues].sort((a, b) => direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq);
          }
          sendList(res, issues.map((i) => issueJson(repo, i)), url, req);
          return;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (parsed === null) { sendStatus(res, 400, 'Invalid JSON'); return; }
          const title = String(parsed.title ?? '');
          if (!title) { sendStatus(res, 422, 'Title is required'); return; }
          const labelNames = Array.isArray(parsed.labels) ? (parsed.labels as unknown[]).map(String) : [];
          for (const ln of labelNames) {
            if (!repo.labels.has(ln)) { sendStatus(res, 422, `Label "${ln}" does not exist`); return; }
          }
          const issue: Issue = {
            number: repo.nextIssue++,
            title,
            body: typeof parsed.body === 'string' ? parsed.body : '',
            state: 'open',
            labels: labelNames,
            comments: [],
            createdSeq: nextSeq(),
          };
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
      }
      const num = Number(rest[1]);
      const issue = Number.isInteger(num) ? repo.issues.find((i) => i.number === num) : undefined;
      if (issue === undefined) { sendStatus(res, 404, 'Not Found'); return; }
      if (rest.length === 2) {
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
        if (method === 'PATCH') {
          const parsed = parseJsonBody(body);
          if (parsed === null) { sendStatus(res, 400, 'Invalid JSON'); return; }
          if (typeof parsed.state === 'string' && (parsed.state === 'open' || parsed.state === 'closed')) issue.state = parsed.state;
          if (typeof parsed.title === 'string') issue.title = parsed.title;
          if (typeof parsed.body === 'string') issue.body = parsed.body;
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          sendList(res, issue.comments.map((c) => commentJson(repo, issue, c)), url, req);
          return;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (parsed === null) { sendStatus(res, 400, 'Invalid JSON'); return; }
          const commentBody = String(parsed.body ?? '');
          if (!commentBody) { sendStatus(res, 422, 'Body is required'); return; }
          const comment: Comment = { id: repo.nextComment++, body: commentBody, createdSeq: nextSeq() };
          issue.comments.push(comment);
          sendJson(res, 201, commentJson(repo, issue, comment));
          return;
        }
      }
      sendStatus(res, 404, 'Not Found');
      return;
    }

    // /repos/:o/:r/pulls[/:n[/files|/merge]]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const pulls = repo.pulls.filter((p) => state === 'all' || p.state === state);
          sendList(res, pulls.map((p) => pullJson(repo, p)), url, req);
          return;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (parsed === null) { sendStatus(res, 400, 'Invalid JSON'); return; }
          const title = String(parsed.title ?? '');
          const head = String(parsed.head ?? '');
          const base = String(parsed.base ?? '');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!title || headSha === undefined || baseSha === undefined) {
            sendStatus(res, 422, 'Invalid head or base branch');
            return;
          }
          const pull: Pull = {
            number: repo.nextPull++,
            title,
            body: typeof parsed.body === 'string' ? parsed.body : '',
            state: 'open',
            headRef: head,
            baseRef: base,
            headSha,
            baseSha,
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            createdSeq: nextSeq(),
          };
          repo.pulls.push(pull);
          sendJson(res, 201, pullJson(repo, pull));
          return;
        }
      }
      const num = Number(rest[1]);
      const pull = Number.isInteger(num) ? repo.pulls.find((p) => p.number === num) : undefined;
      if (pull === undefined) { sendStatus(res, 404, 'Not Found'); return; }
      if (rest.length === 2 && method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return; }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const baseTip = baseTipSha(repo, pull);
        const mb = mergeBase(repo, pull.headSha, baseTip);
        const headView = commitView(repo, pull.headSha);
        const baseView = commitView(repo, baseTip);
        if (!headView || !baseView) { sendStatus(res, 404, 'Not Found'); return; }
        const mbView = mb ? commitView(repo, mb) : null;
        const files = diffFiles(
          repo,
          mbView ? flattenTree(repo, mbView.tree) : flattenTree(repo, baseView.tree),
          flattenTree(repo, headView.tree),
        );
        sendJson(res, 200, files.map((f) => {
          const headFiles = flattenTree(repo, headView.tree);
          return {
            sha: headFiles.get(f.path)?.oid ?? '',
            filename: f.path,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.additions + f.deletions,
            blob_url: '',
            raw_url: '',
            contents_url: '',
          };
        }));
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const parsed = parseJsonBody(body);
        if (parsed === null) { sendStatus(res, 400, 'Invalid JSON'); return; }
        const method_ = typeof parsed.merge_method === 'string' ? parsed.merge_method : 'merge';
        const result = doMerge(repo, pull, method_);
        if (!result.ok) {
          if (result.message === 'Merge conflict') { sendStatus(res, 405, 'Merge conflict'); return; }
          sendStatus(res, 422, result.message ?? 'Cannot merge');
          return;
        }
        sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
      sendStatus(res, 404, 'Not Found');
      return;
    }
  }

  sendStatus(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL v4 — small parser + executor for the documented surface
// ---------------------------------------------------------------------------
type GqlValue = string | number | boolean | null | GqlValue[] | { [k: string]: GqlValue } | { __var: string };
interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selection: GqlField[] | null;
}
interface GqlOp { operation: 'query' | 'mutation'; selection: GqlField[]; }

class GqlParser {
  private readonly src: string;
  private pos = 0;
  constructor(src: string) { this.src = src; }

  private skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') this.pos++;
      else if (c === '#') { while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++; }
      else break;
    }
  }

  private peek(): string { return this.src[this.pos] ?? ''; }
  private expect(ch: string): void {
    this.skipWs();
    if (this.src[this.pos] !== ch) throw new Error(`expected ${ch} at ${this.pos}`);
    this.pos++;
  }
  private readName(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }
  private readString(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos++];
      if (c === '"') return out;
      if (c === '\\') {
        const e = this.src[this.pos++];
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
      } else out += c;
    }
    throw new Error('unterminated string');
  }
  private readNumber(): number {
    this.skipWs();
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected number at ${this.pos}`);
    this.pos += m[0].length;
    return Number(m[0]);
  }

  parseValue(): GqlValue {
    this.skipWs();
    const c = this.peek();
    if (c === '"') return this.readString();
    if (c === '$') { this.pos++; return { __var: this.readName() }; }
    if (c === '[') {
      this.pos++;
      const items: GqlValue[] = [];
      while (true) {
        this.skipWs();
        if (this.peek() === ']') { this.pos++; return items; }
        items.push(this.parseValue());
      }
    }
    if (c === '{') {
      this.pos++;
      const obj: Record<string, GqlValue> = {};
      while (true) {
        this.skipWs();
        if (this.peek() === '}') { this.pos++; return obj; }
        const key = this.readName();
        this.skipWs();
        this.expect(':');
        obj[key] = this.parseValue();
      }
    }
    if (c === '-' || (c >= '0' && c <= '9')) return this.readNumber();
    const name = this.readName();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return name;
  }

  private parseArgs(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    this.skipWs();
    if (this.peek() !== '(') return args;
    this.pos++;
    while (true) {
      this.skipWs();
      if (this.peek() === ')') { this.pos++; return args; }
      const key = this.readName();
      this.skipWs();
      this.expect(':');
      args[key] = this.parseValue();
    }
  }

  private parseSelectionSet(fragments: Map<string, GqlField[]>): GqlField[] {
    this.skipWs();
    this.expect('{');
    const fields: GqlField[] = [];
    while (true) {
      this.skipWs();
      if (this.peek() === '}') { this.pos++; return fields; }
      if (this.src.startsWith('...', this.pos)) {
        this.pos += 3;
        this.skipWs();
        if (this.src.startsWith('on ', this.pos)) {
          this.pos += 3;
          this.readName();
          fields.push(...this.parseSelectionSet(fragments));
        } else {
          const fragName = this.readName();
          const frag = fragments.get(fragName);
          if (frag) fields.push(...frag);
        }
        continue;
      }
      const first = this.readName();
      this.skipWs();
      let alias: string | null = null;
      let name = first;
      if (this.peek() === ':') {
        this.pos++;
        alias = first;
        name = this.readName();
      }
      const args = this.parseArgs();
      this.skipWs();
      const selection = this.peek() === '{' ? this.parseSelectionSet(fragments) : null;
      fields.push({ alias, name, args, selection });
    }
  }

  parseDocument(): GqlOp[] {
    const ops: GqlOp[] = [];
    const fragments = new Map<string, GqlField[]>();
    while (true) {
      this.skipWs();
      if (this.pos >= this.src.length) break;
      if (this.peek() === '{') {
        ops.push({ operation: 'query', selection: this.parseSelectionSet(fragments) });
        continue;
      }
      const keyword = this.readName();
      if (keyword === 'fragment') {
        const fragName = this.readName();
        this.skipWs();
        if (this.src.startsWith('on ', this.pos)) { this.pos += 3; this.readName(); }
        fragments.set(fragName, this.parseSelectionSet(fragments));
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation') throw new Error(`unexpected ${keyword}`);
      this.skipWs();
      if (this.peek() !== '(' && this.peek() !== '{') this.readName();
      this.skipWs();
      if (this.peek() === '(') {
        let depth = 0;
        while (this.pos < this.src.length) {
          const c = this.src[this.pos++];
          if (c === '(') depth++;
          else if (c === ')') { depth--; if (depth === 0) break; }
          else if (c === '"') { while (this.pos < this.src.length && this.src[this.pos] !== '"') this.pos++; this.pos++; }
        }
      }
      ops.push({ operation: keyword, selection: this.parseSelectionSet(fragments) });
    }
    return ops;
  }
}

function resolveVars(value: GqlValue, vars: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ('__var' in value) return vars[(value as { __var: string }).__var];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveVars(v, vars);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => resolveVars(v, vars));
  return value;
}

function argStr(args: Record<string, GqlValue>, vars: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined) return undefined;
  const r = resolveVars(v, vars);
  return typeof r === 'string' ? r : undefined;
}
function argInt(args: Record<string, GqlValue>, vars: Record<string, unknown>, name: string): number | undefined {
  const v = args[name];
  if (v === undefined) return undefined;
  const r = resolveVars(v, vars);
  return typeof r === 'number' ? r : undefined;
}
function argObj(args: Record<string, GqlValue>, vars: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const v = args[name];
  if (v === undefined) return undefined;
  const r = resolveVars(v, vars);
  return typeof r === 'object' && r !== null && !Array.isArray(r) ? (r as Record<string, unknown>) : undefined;
}

function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}
function decodeGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = raw.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

interface GqlNode { __type: string; repo?: Repo; issue?: Issue; pull?: Pull; comment?: Comment; value?: unknown; }

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  BranchRef: ['name'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes'],
  FileConnection: ['nodes'],
  ChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor'],
  __Type: ['fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  IssuePayload: ['issue'],
  PullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
};

const INTROSPECTION: Record<string, { fields?: string[]; enumValues?: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body'] },
  PullRequest: { fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'] },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'] },
  SearchType: { enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'CODE', 'PROJECT', 'WIKI'] },
};

function executeFields(node: GqlNode, fields: GqlField[], vars: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> | null {
  const type = node.__type;
  const allowed = TYPE_FIELDS[type] ?? [];
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const outName = field.alias ?? field.name;
    if (!allowed.includes(field.name)) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${type}".` });
      data[outName] = null;
      continue;
    }
    data[outName] = resolveField(node, field, vars, errors);
  }
  return data;
}

function resolveField(node: GqlNode, field: GqlField, vars: Record<string, unknown>, errors: { message: string }[]): unknown {
  const type = node.__type;
  const sel = field.selection;
  const sub = (child: GqlNode | null): unknown => {
    if (child === null) return null;
    if (!sel) return child.value ?? null;
    return executeFields(child, sel, vars, errors);
  };

  if (type === 'Query') {
    if (field.name === 'viewer') return sub({ __type: 'User' });
    if (field.name === 'repository') {
      const owner = argStr(field.args, vars, 'owner');
      const name = argStr(field.args, vars, 'name');
      const repo = owner && name ? findRepo(owner, name) : null;
      return sub(repo ? { __type: 'Repository', repo } : null);
    }
    if (field.name === 'node') {
      const id = argStr(field.args, vars, 'id');
      const dec = id ? decodeGid(id) : null;
      if (!dec) return null;
      if (dec.kind === 'Repository') {
        const repo = getRepoById(Number(dec.parts[0]));
        return sub(repo ? { __type: 'Repository', repo } : null);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = argStr(field.args, vars, 'name');
      const info = name ? INTROSPECTION[name] : undefined;
      if (!info) return null;
      return sub({ __type: '__Type', value: info });
    }
  }

  if (type === 'Mutation') {
    const input = argObj(field.args, vars, 'input') ?? {};
    if (field.name === 'createIssue') {
      const dec = typeof input.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
      const repo = dec?.kind === 'Repository' ? getRepoById(Number(dec.parts[0])) : null;
      if (!repo) return sub(null);
      const issue: Issue = {
        number: repo.nextIssue++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: nextSeq(),
      };
      repo.issues.push(issue);
      return sub({ __type: 'IssuePayload', repo, issue });
    }
    if (field.name === 'closeIssue') {
      const dec = typeof input.issueId === 'string' ? decodeGid(input.issueId) : null;
      if (!dec || dec.kind !== 'Issue') return sub(null);
      const repo = getRepoById(Number(dec.parts[0]));
      const issue = repo?.issues.find((i) => i.number === Number(dec.parts[1]));
      if (!issue) return sub(null);
      issue.state = 'closed';
      return sub({ __type: 'IssuePayload', repo, issue });
    }
    if (field.name === 'createPullRequest') {
      const dec = typeof input.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
      const repo = dec?.kind === 'Repository' ? getRepoById(Number(dec.parts[0])) : null;
      if (!repo) return sub(null);
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return sub(null);
      const pull: Pull = {
        number: repo.nextPull++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: nextSeq(),
      };
      repo.pulls.push(pull);
      return sub({ __type: 'PullRequestPayload', repo, pull });
    }
    if (field.name === 'mergePullRequest') {
      const dec = typeof input.pullRequestId === 'string' ? decodeGid(input.pullRequestId) : null;
      if (!dec || dec.kind !== 'PullRequest') return sub(null);
      const repo = getRepoById(Number(dec.parts[0]));
      const pull = repo?.pulls.find((p) => p.number === Number(dec.parts[1]));
      if (!pull || !repo) return sub(null);
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
      const result = doMerge(repo, pull, method);
      if (!result.ok) return sub(null);
      return sub({ __type: 'PullRequestPayload', repo, pull });
    }
    if (field.name === 'addComment') {
      const dec = typeof input.subjectId === 'string' ? decodeGid(input.subjectId) : null;
      if (!dec || dec.kind !== 'Issue') return sub(null);
      const repo = getRepoById(Number(dec.parts[0]));
      const issue = repo?.issues.find((i) => i.number === Number(dec.parts[1]));
      if (!issue || !repo) return sub(null);
      const comment: Comment = { id: repo.nextComment++, body: String(input.body ?? ''), createdSeq: nextSeq() };
      issue.comments.push(comment);
      return sub({ __type: 'AddCommentPayload', repo, issue, comment });
    }
  }

  if (type === 'User') {
    if (field.name === 'login') return VIEWER.login;
    if (field.name === 'id') return gid('User', VIEWER.id);
    if (field.name === 'name') return VIEWER.name;
    if (field.name === 'email') return VIEWER.email;
  }

  if (type === 'Repository' && node.repo) {
    const repo = node.repo;
    if (field.name === 'id') return gid('Repository', repo.id);
    if (field.name === 'databaseId') return repo.id;
    if (field.name === 'name') return repo.name;
    if (field.name === 'nameWithOwner') return `${VIEWER.login}/${repo.name}`;
    if (field.name === 'owner') return sub({ __type: 'User' });
    if (field.name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ? sub({ __type: 'BranchRef', value: repo.defaultBranch }) : null;
    }
    if (field.name === 'viewerPermission') return 'WRITE';
    if (field.name === 'hasIssuesEnabled') return true;
    if (field.name === 'issue') {
      const number = argInt(field.args, vars, 'number');
      const issue = number !== undefined ? repo.issues.find((i) => i.number === number) : undefined;
      return sub(issue ? { __type: 'Issue', repo, issue } : null);
    }
    if (field.name === 'issues') {
      let issues = [...repo.issues];
      const states = field.args.states ? (resolveVars(field.args.states, vars) as string[] | undefined) : undefined;
      if (states && states.length > 0) {
        issues = issues.filter((i) => states.includes(i.state.toUpperCase()));
      }
      const orderBy = field.args.orderBy ? (resolveVars(field.args.orderBy, vars) as Record<string, unknown> | undefined) : undefined;
      const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'ASC';
      issues.sort((a, b) => direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq);
      const first = argInt(field.args, vars, 'first');
      const after = argStr(field.args, vars, 'after');
      let start = 0;
      if (after) {
        try {
          const idx = Number(Buffer.from(after, 'base64').toString('utf8'));
          if (Number.isInteger(idx)) start = idx + 1;
        } catch { /* ignore */ }
      }
      const page = first !== undefined ? issues.slice(start, start + first) : issues.slice(start);
      const endCursor = page.length > 0 ? Buffer.from(String(start + page.length - 1)).toString('base64') : null;
      const hasNextPage = start + page.length < issues.length;
      return sub({
        __type: 'IssueConnection',
        value: {
          nodes: page.map((issue) => ({ __type: 'Issue', repo, issue } as GqlNode)),
          pageInfo: { hasNextPage, endCursor },
        },
      });
    }
    if (field.name === 'pullRequests') {
      const first = argInt(field.args, vars, 'first');
      const pulls = first !== undefined ? repo.pulls.slice(0, first) : repo.pulls;
      return sub({
        __type: 'PullRequestConnection',
        value: { nodes: pulls.map((pull) => ({ __type: 'PullRequest', repo, pull } as GqlNode)) },
      });
    }
    if (field.name === 'pullRequest') {
      const number = argInt(field.args, vars, 'number');
      const pull = number !== undefined ? repo.pulls.find((p) => p.number === number) : undefined;
      return sub(pull ? { __type: 'PullRequest', repo, pull } : null);
    }
  }

  if (type === 'Issue' && node.issue && node.repo) {
    const issue = node.issue;
    if (field.name === 'id') return gid('Issue', node.repo.id, issue.number);
    if (field.name === 'number') return issue.number;
    if (field.name === 'title') return issue.title;
    if (field.name === 'state') return issue.state.toUpperCase();
    if (field.name === 'body') return issue.body;
  }

  if (type === 'PullRequest' && node.pull && node.repo) {
    const pull = node.pull;
    if (field.name === 'id') return gid('PullRequest', node.repo.id, pull.number);
    if (field.name === 'number') return pull.number;
    if (field.name === 'headRefName') return pull.headRef;
    if (field.name === 'baseRefName') return pull.baseRef;
    if (field.name === 'mergeable') {
      if (pull.state !== 'open') return 'UNKNOWN';
      return isMergeable(node.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    }
    if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    if (field.name === 'merged') return pull.merged;
    if (field.name === 'files') {
      const first = argInt(field.args, vars, 'first');
      const baseTip = baseTipSha(node.repo, pull);
      const mb = mergeBase(node.repo, pull.headSha, baseTip);
      const headView = commitView(node.repo, pull.headSha);
      const baseView = commitView(node.repo, baseTip);
      if (!headView || !baseView) return sub(null);
      const mbView = mb ? commitView(node.repo, mb) : null;
      const files = diffFiles(
        node.repo,
        mbView ? flattenTree(node.repo, mbView.tree) : flattenTree(node.repo, baseView.tree),
        flattenTree(node.repo, headView.tree),
      );
      const nodes = (first !== undefined ? files.slice(0, first) : files).map((f) => ({ __type: 'ChangedFile', value: f.path } as GqlNode));
      return sub({ __type: 'FileConnection', value: { nodes } });
    }
  }

  if (type === 'BranchRef') {
    if (field.name === 'name') return node.value as string;
  }

  if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'FileConnection') {
    const v = node.value as { nodes: GqlNode[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
    if (field.name === 'nodes') {
      if (!sel) return v.nodes.map((n) => n.value ?? null);
      return v.nodes.map((n) => executeFields(n, sel, vars, errors));
    }
    if (field.name === 'pageInfo' && v.pageInfo) {
      return sub({ __type: 'PageInfo', value: v.pageInfo });
    }
  }

  if (type === 'PageInfo') {
    const v = node.value as { hasNextPage: boolean; endCursor: string | null };
    if (field.name === 'hasNextPage') return v.hasNextPage;
    if (field.name === 'endCursor') return v.endCursor;
  }

  if (type === '__Type') {
    const v = node.value as { fields?: string[]; enumValues?: string[] };
    if (field.name === 'fields') {
      const list = (v.fields ?? []).map((name) => ({ __type: '__Field', value: name } as GqlNode));
      if (!sel) return list.map((n) => n.value);
      return list.map((n) => executeFields(n, sel, vars, errors));
    }
    if (field.name === 'enumValues') {
      const list = (v.enumValues ?? []).map((name) => ({ __type: '__EnumValue', value: name } as GqlNode));
      if (!sel) return list.map((n) => n.value);
      return list.map((n) => executeFields(n, sel, vars, errors));
    }
  }

  if (type === '__Field' || type === '__EnumValue') {
    if (field.name === 'name') return node.value as string;
  }

  if (type === 'IssuePayload' && node.issue && node.repo) {
    if (field.name === 'issue') return sub({ __type: 'Issue', repo: node.repo, issue: node.issue });
  }
  if (type === 'PullRequestPayload' && node.pull && node.repo) {
    if (field.name === 'pullRequest') return sub({ __type: 'PullRequest', repo: node.repo, pull: node.pull });
  }
  if (type === 'AddCommentPayload' && node.comment && node.repo && node.issue) {
    if (field.name === 'commentEdge') {
      return sub({ __type: 'IssueCommentEdge', repo: node.repo, issue: node.issue, comment: node.comment });
    }
  }
  if (type === 'IssueCommentEdge' && node.comment) {
    if (field.name === 'node') return sub({ __type: 'IssueComment', repo: node.repo, issue: node.issue, comment: node.comment });
  }
  if (type === 'IssueComment' && node.comment && node.repo && node.issue) {
    if (field.name === 'id') return gid('IssueComment', node.repo.id, node.issue.number, node.comment.id);
    if (field.name === 'body') return node.comment.body;
  }
  if (type === 'ChangedFile') {
    if (field.name === 'path') return node.value as string;
  }

  return null;
}

function executeGraphQL(body: unknown): unknown {
  const record = body as Record<string, unknown>;
  const queries: { query: string; variables: Record<string, unknown> }[] = [];
  if (Array.isArray(body)) {
    for (const item of body) {
      if (item && typeof item === 'object') {
        const r = item as Record<string, unknown>;
        queries.push({ query: String(r.query ?? ''), variables: (r.variables as Record<string, unknown>) ?? {} });
      }
    }
  } else if (record && typeof record === 'object') {
    queries.push({ query: String(record.query ?? ''), variables: (record.variables as Record<string, unknown>) ?? {} });
  }
  const results = queries.map(({ query, variables }) => {
    try {
      const parser = new GqlParser(query);
      const ops = parser.parseDocument();
      if (ops.length === 0) return { data: null, errors: [{ message: 'Empty document' }] };
      const op = ops[0];
      const root: GqlNode = { __type: op.operation === 'mutation' ? 'Mutation' : 'Query' };
      const errors: { message: string }[] = [];
      const data = executeFields(root, op.selection, variables, errors);
      return errors.length > 0 ? { data, errors } : { data };
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
    }
  });
  return Array.isArray(body) ? results : results[0];
}

// ---------------------------------------------------------------------------
// MCP — JSON-RPC 2.0 over Streamable HTTP at /mcp
// ---------------------------------------------------------------------------
interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; }

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Repository name' }, private: { type: 'boolean', description: 'Whether the repository is private' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, state: { type: 'string', description: 'open, closed, or all' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, pull_number: { type: 'integer' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpRepoFromArgs(args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !name) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) { owner = parts[0]; name = parts[1]; }
  }
  if (!owner || !name) return null;
  return findRepo(owner, name);
}

function mcpText(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }] };
}

function mcpErrorResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

function handleMcpCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (!repoName) return mcpErrorResult('Invalid repository name');
      const repo = store.createRepo(VIEWER.login, repoName, Boolean(args.private ?? false), '');
      if (!repo) return mcpErrorResult('Repository already exists');
      return mcpText(JSON.stringify(repoJson(repo)));
    }
    case 'get_repo': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return mcpErrorResult('Not Found');
      return mcpText(JSON.stringify(repoJson(repo)));
    }
    case 'create_issue': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return mcpErrorResult('Not Found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (!title) return mcpErrorResult('title is required');
      const issue: Issue = {
        number: repo.nextIssue++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: nextSeq(),
      };
      repo.issues.push(issue);
      return mcpText(JSON.stringify(issueJson(repo, issue)));
    }
    case 'list_issues': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return mcpErrorResult('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((i) => state === 'all' || i.state === state);
      return mcpText(JSON.stringify(issues.map((i) => issueJson(repo, i))));
    }
    case 'create_pull_request': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return mcpErrorResult('Not Found');
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return mcpErrorResult('Invalid head or base branch');
      const pull: Pull = {
        number: repo.nextPull++,
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: nextSeq(),
      };
      repo.pulls.push(pull);
      return mcpText(JSON.stringify(pullJson(repo, pull)));
    }
    case 'merge_pull_request': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return mcpErrorResult('Not Found');
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return mcpErrorResult('Not Found');
      const result = doMerge(repo, pull, 'squash');
      if (!result.ok) return mcpErrorResult(result.message ?? 'Cannot merge');
      return mcpText(JSON.stringify({ sha: result.sha, merged: true, message: 'Pull request successfully merged' }));
    }
    default:
      return mcpErrorResult(`Unknown tool: ${name}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  const sendRpc = (status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void => {
    const data = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length, ...extraHeaders });
    res.end(data);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendRpc(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendRpc(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const msg = parsed as Record<string, unknown>;
  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params as Record<string, unknown>) ?? {};
  const meta = (params._meta as Record<string, unknown>) ?? {};
  const revision = (typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string'
    ? (meta['io.modelcontextprotocol/protocolVersion'] as string)
    : (typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : '2025-11-25'));

  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (method === 'server/discover') {
    sendRpc(200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2026-07-28',
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    });
    return;
  }
  if (method === 'initialize') {
    sendRpc(200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: revision,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      },
    }, { 'Mcp-Session-Id': randomUUID() });
    return;
  }
  if (method === 'ping') {
    sendRpc(200, { jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    sendRpc(200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments as Record<string, unknown>) ?? {};
    const known = MCP_TOOLS.some((t) => t.name === toolName);
    if (!known) {
      sendRpc(200, { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${toolName}` } });
      return;
    }
    const tool = MCP_TOOLS.find((t) => t.name === toolName)!;
    const required = (tool.inputSchema.required as string[]) ?? [];
    for (const reqArg of required) {
      const hasDirect = args[reqArg] !== undefined;
      const hasFullName = reqArg !== 'owner' && reqArg !== 'repo' && typeof args.full_name === 'string';
      if (!hasDirect && !hasFullName) {
        sendRpc(200, { jsonrpc: '2.0', id, result: mcpErrorResult(`Missing required argument: ${reqArg}`) });
        return;
      }
    }
    const result = handleMcpCall(toolName, args);
    sendRpc(200, { jsonrpc: '2.0', id, result });
    return;
  }
  sendRpc(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// ---------------------------------------------------------------------------
// Router + server
// ---------------------------------------------------------------------------
export function createApp(): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';

      // Health probe: no auth.
      if (url.pathname === '/healthz' && method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Everything else needs the shop token.
      if (!authed(req)) {
        sendStatus(res, 401, 'Requires authentication');
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
      if (gitMatch) {
        const repo = findRepo(gitMatch[1], gitMatch[2]);
        if (repo === null) { sendStatus(res, 404, 'Not Found'); return; }
        const action = gitMatch[3];
        if (action === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { sendStatus(res, 400, 'Invalid service'); return; }
          handleInfoRefs(req, res, repo, service);
          return;
        }
        const body = await readBody(req);
        if (action === 'git-upload-pack' && method === 'POST') { handleUploadPack(req, res, repo, body); return; }
        if (action === 'git-receive-pack' && method === 'POST') { handleReceivePack(req, res, repo, body); return; }
        sendStatus(res, 404, 'Not Found');
        return;
      }

      // REST v3
      if (url.pathname.startsWith('/api/v3')) {
        const body = await readBody(req);
        await handleRest(req, res, url, body);
        return;
      }

      // GraphQL v4
      if (url.pathname === '/api/graphql' && method === 'POST') {
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] });
          return;
        }
        sendJson(res, 200, executeGraphQL(parsed));
        return;
      }

      // MCP
      if (url.pathname === '/mcp' && method === 'POST') {
        const body = await readBody(req);
        await handleMcp(req, res, body);
        return;
      }

      sendStatus(res, 404, 'Not Found');
    } catch (err) {
      if (!res.headersSent) sendStatus(res, 500, err instanceof Error ? err.message : 'Internal error');
      else res.end();
    }
  });
}
