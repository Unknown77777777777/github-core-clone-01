// In-memory store for one forge process. Everything the suite drives lives here: git
// objects and refs, issues, labels, comments and pull requests, all sharing one object
// store per repository. No disk, no network, no git binary.
//
// Commits the forge creates (contents PUT, squash merges) use a fixed identity and epoch,
// so their bytes are deterministic.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  storeObject,
  ZERO_OID,
  type GitObject,
  type TreeEntry,
} from './git.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

const FIXED_TIME = '2026-11-19T00:00:00Z';
let seqCounter = 0;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: nextSeq(),
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }
}

// -------------------------------------------------------------------------------------------
// trees
// -------------------------------------------------------------------------------------------

/** Flatten a tree object into path -> {mode, oid} (files only, recursive). */
export function flattenTree(
  repo: Repo,
  treeOid: string,
  prefix = '',
  out: Map<string, { mode: string; oid: string }> = new Map(),
): Map<string, { mode: string; oid: string }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      flattenTree(repo, entry.oid, path, out);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/** Build (and store) a tree object from a flat path map. Returns the tree oid. */
export function buildTreeFromPaths(
  repo: Repo,
  files: Map<string, { mode: string; oid: string }>,
): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.push({ mode: file.mode, oid: file.oid, name: parts[parts.length - 1] });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', oid: build(child), name });
    }
    return storeObject(repo.objects, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Tree oid of a commit, or null. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  try {
    return parseCommit(obj.data).tree;
  } catch {
    return null;
  }
}

/** Create a commit on top of `parents` with the given tree and message; returns its oid. */
export function makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
  return storeObject(repo.objects, 'commit', buildCommit(treeOid, parents, message));
}

/** Resolve a ref name (refs/heads/x, heads/x, or a sha) to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  return repo.refs.get(full) ?? null;
}

/** All ancestors of a commit (itself included), newest-first traversal order. */
export function commitHistory(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

/** True when `ancestor` is an ancestor of (or equal to) `tip`. */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Merge-base: the newest common ancestor of two commits (first found walking both). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set(commitHistory(repo, a));
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

/** Diff two flat file maps: added / removed / modified paths with line counts. */
export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

export function diffFiles(
  repo: Repo,
  baseFiles: Map<string, { mode: string; oid: string }>,
  headFiles: Map<string, { mode: string; oid: string }>,
): FileDiff[] {
  const out: FileDiff[] = [];
  const lineCount = (oid: string): number => {
    const obj = repo.objects.get(oid);
    if (!obj) return 0;
    const text = obj.data.toString('utf8');
    if (text.length === 0) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  for (const [path, head] of headFiles) {
    const base = baseFiles.get(path);
    if (!base) {
      out.push({ path, status: 'added', additions: lineCount(head.oid), deletions: 0 });
    } else if (base.oid !== head.oid) {
      out.push({ path, status: 'modified', additions: lineCount(head.oid), deletions: lineCount(base.oid) });
    }
  }
  for (const [path, base] of baseFiles) {
    if (!headFiles.has(path)) {
      out.push({ path, status: 'removed', additions: 0, deletions: lineCount(base.oid) });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Set one file in a tree: returns the new tree oid. */
export function setPathInTree(
  repo: Repo,
  baseTreeOid: string | null,
  path: string,
  blobOid: string,
): string {
  const files = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map<string, { mode: string; oid: string }>();
  files.set(path, { mode: '100644', oid: blobOid });
  return buildTreeFromPaths(repo, files);
}

/** Remove one file from a tree: returns the new tree oid. */
export function removePathFromTree(repo: Repo, baseTreeOid: string, path: string): string {
  const files = flattenTree(repo, baseTreeOid);
  files.delete(path);
  return buildTreeFromPaths(repo, files);
}

/** Blob oid for file content bytes. */
export function blobOid(repo: Repo, content: Buffer): string {
  return storeObject(repo.objects, 'blob', content);
}

/** Read a file's bytes from a tree, or null. */
export function readPath(repo: Repo, treeOid: string, path: string): Buffer | null {
  const files = flattenTree(repo, treeOid);
  const entry = files.get(path);
  if (!entry) return null;
  const obj = repo.objects.get(entry.oid);
  return obj && obj.type === 'blob' ? obj.data : null;
}

export { FIXED_TIME, nextSeq, ZERO_OID, collectReachable, hashObject, parseTag };
