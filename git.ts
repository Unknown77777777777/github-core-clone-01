import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { Repo, GitObject, ObjType } from "./store.ts";
import { sha1Of, storeObject } from "./store.ts";

// ---------- pkt-line ----------
export function pktLine(s: string | Buffer): Buffer {
  const payload = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, "0"), "ascii"), payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from("0000", "ascii");
}

export function pktDelim(): Buffer {
  return Buffer.from("0001", "ascii");
}

export interface PktRead {
  lines: Buffer[];
  rest: Buffer;
}

// Read pkt-lines until a flush (0000). Returns payload lines (without the
// 4-byte length prefix) and the unconsumed remainder.
export function readPktLines(buf: Buffer): PktRead {
  const lines: Buffer[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString("ascii"), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      off += 4;
      break;
    }
    if (len === 1) {
      off += 4;
      continue;
    }
    if (off + len > buf.length) break;
    lines.push(buf.subarray(off + 4, off + len));
    off += len;
  }
  return { lines, rest: buf.subarray(off) };
}

// ---------- objects ----------
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString("utf8");
  const headEnd = text.indexOf("\n\n");
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : "";
  let tree = "";
  const parents: string[] = [];
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.subarray(off, sp).toString("ascii");
    const nul = data.indexOf(0, sp);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString("utf8");
    const sha = data.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === "40000" ? a.name + "/" : a.name;
    const bn = b.mode === "40000" ? b.name + "/" : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(e.mode + " " + e.name + "\0", "utf8"));
    parts.push(Buffer.from(e.sha, "hex"));
  }
  return Buffer.concat(parts);
}

export function makeCommit(repo: Repo, treeSha: string, parents: string[], message: string): string {
  const author = "Forge <forge@example.com> 1700000000 +0000";
  let text = "tree " + treeSha + "\n";
  for (const p of parents) text += "parent " + p + "\n";
  text += "author " + author + "\ncommitter " + author + "\n\n" + message + "\n";
  return storeObject(repo, "commit", Buffer.from(text, "utf8"));
}

// Walk a tree path; returns the blob sha or null.
export function lookupPath(repo: Repo, commitSha: string, path: string): { sha: string; mode: string; type: string } | null {
  const commitObj = repo.objects.get(commitSha);
  if (!commitObj || commitObj.type !== "commit") return null;
  const { tree } = parseCommit(commitObj.data);
  const parts = path.split("/").filter((p) => p.length > 0);
  let curTree = tree;
  for (let i = 0; i < parts.length; i++) {
    const treeObj = repo.objects.get(curTree);
    if (!treeObj) return null;
    const entries = parseTree(treeObj.data);
    const e = entries.find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) {
      const obj = repo.objects.get(e.sha);
      return { sha: e.sha, mode: e.mode, type: obj ? obj.type : "blob" };
    }
    if (e.mode !== "40000") return null;
    curTree = e.sha;
  }
  return null;
}

// List all files (path -> blob sha) under a commit's tree.
export function listFiles(repo: Repo, commitSha: string): Map<string, string> {
  const out = new Map<string, string>();
  const commitObj = repo.objects.get(commitSha);
  if (!commitObj || commitObj.type !== "commit") return out;
  const { tree } = parseCommit(commitObj.data);
  const walk = (treeSha: string, prefix: string) => {
    const obj = repo.objects.get(treeSha);
    if (!obj) return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === "40000") walk(e.sha, prefix + e.name + "/");
      else out.set(prefix + e.name, e.sha);
    }
  };
  walk(tree, "");
  return out;
}

// Replace (or delete, when content is null) one path in a tree, returning
// the new root tree sha. Creates new tree/blob objects in the store.
export function setPathInTree(repo: Repo, rootTreeSha: string, path: string, content: Buffer | null): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  const rec = (treeSha: string | null, idx: number): string => {
    let entries: TreeEntry[] = [];
    if (treeSha) {
      const obj = repo.objects.get(treeSha);
      if (obj) entries = parseTree(obj.data);
    }
    const name = parts[idx];
    const last = idx === parts.length - 1;
    if (last) {
      entries = entries.filter((e) => e.name !== name);
      if (content !== null) {
        const blobSha = storeObject(repo, "blob", content);
        entries.push({ mode: "100644", name, sha: blobSha });
      }
    } else {
      const existing = entries.find((e) => e.name === name);
      const childSha = rec(existing && existing.mode === "40000" ? existing.sha : null, idx + 1);
      entries = entries.filter((e) => e.name !== name);
      // Keep empty dirs out: if the child tree is empty, drop it.
      const childObj = repo.objects.get(childSha);
      if (childObj && childObj.data.length > 0) {
        entries.push({ mode: "40000", name, sha: childSha });
      }
    }
    return storeObject(repo, "tree", buildTree(entries));
  };
  return rec(rootTreeSha, 0);
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== "commit") continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (ancA.has(cur)) continue;
    ancA.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== "commit") continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (ancA.has(cur)) return cur;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== "commit") continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

// ---------- packfile reading ----------
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    while (off < delta.length) {
      const b = delta[off++];
      out |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return out;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  void srcSize;
  const parts: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) cpOff |= delta[off++] << (i * 8);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) cpSize |= delta[off++] << (i * 8);
      }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op) {
      parts.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error("bad delta opcode 0");
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== dstSize) throw new Error("delta size mismatch");
  return out;
}

export function parsePack(repo: Repo, pack: Buffer): string[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("not a packfile");
  }
  const count = pack.readUInt32BE(8);
  let off = 12;
  const parsed: { sha: string; type: ObjType; data: Buffer; ofs: number }[] = [];
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  const readObjectHeader = (): { typeNum: number; size: number } => {
    const b0 = pack[off++];
    let typeNum = (b0 >> 4) & 0x7;
    let size = b0 & 0x0f;
    let shift = 4;
    while (b0 & 0x80) {
      const b = pack[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return { typeNum, size };
  };
  const typeNames: Record<number, ObjType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
  for (let i = 0; i < count; i++) {
    const start = off;
    const { typeNum, size } = readObjectHeader();
    if (typeNum === 6) {
      // ofs-delta: negative offset varint
      let b = pack[off++];
      let ofs = b & 0x7f;
      while (b & 0x80) {
        b = pack[off++];
        ofs = ((ofs + 1) << 7) | (b & 0x7f);
      }
      const baseOff = start - ofs;
      const inflated = inflateSync(pack.subarray(off));
      const consumed = pack.length - off - 0; // inflateSync consumes whole slice; compute via zlib length below
      void consumed;
      // Determine consumed bytes by re-inflating with a bounded approach:
      // use the trailing trailer: we instead inflate incrementally using
      // inflateSync on progressively larger slices is wasteful; use a
      // manual scan: zlib streams end with adler32, find via inflate of
      // the remaining buffer truncated at the next object is unknown.
      // Practical approach: inflate the rest and measure with a helper
      // that reports unused bytes by trying lengths is expensive.
      // Instead we rely on node zlib: inflateSync throws on trailing
      // garbage only when strict; we compute consumed by binary search
      // on the smallest prefix that inflates to `size` bytes of delta.
      const delta = inflateToSize(pack, off, size);
      const base = byOffset.get(baseOff);
      if (!base) throw new Error("ofs-delta base missing");
      const data = applyDelta(base.data, delta);
      const sha = sha1Of(base.type, data);
      parsed.push({ sha, type: base.type, data, ofs: start });
      byOffset.set(start, { type: base.type, data });
      off += zlibConsumed(pack, off, size);
    } else if (typeNum === 7) {
      const baseSha = pack.subarray(off, off + 20).toString("hex");
      off += 20;
      const delta = inflateToSize(pack, off, size);
      const baseObj = repo.objects.get(baseSha) || parsed.find((p) => p.sha === baseSha);
      if (!baseObj) throw new Error("ref-delta base missing " + baseSha);
      const data = applyDelta(baseObj.data, delta);
      const sha = sha1Of(baseObj.type, data);
      parsed.push({ sha, type: baseObj.type, data, ofs: start });
      byOffset.set(start, { type: baseObj.type, data });
      off += zlibConsumed(pack, off, size);
    } else {
      const type = typeNames[typeNum];
      if (!type) throw new Error("unknown pack type " + typeNum);
      const data = inflateToSize(pack, off, size);
      const sha = sha1Of(type, data);
      parsed.push({ sha, type, data, ofs: start });
      byOffset.set(start, { type, data });
      off += zlibConsumed(pack, off, size);
    }
  }
  for (const p of parsed) {
    if (!repo.objects.has(p.sha)) repo.objects.set(p.sha, { type: p.type, data: p.data });
  }
  return parsed.map((p) => p.sha);
}

// Inflate a zlib stream starting at `off`, expected to produce `size` bytes.
// Returns the inflated bytes (binary search for the exact stream length).
function inflateToSize(pack: Buffer, off: number, size: number): Buffer {
  const len = zlibConsumed(pack, off, size);
  return inflateSync(pack.subarray(off, off + len));
}

// Find how many bytes the zlib stream at `off` occupies by binary search:
// the smallest prefix that inflates successfully to `size` bytes.
const consumedCache = new WeakMap<Buffer, Map<string, number>>();
function zlibConsumed(pack: Buffer, off: number, size: number): number {
  let lo = 1;
  let hi = pack.length - off;
  // Exponential probe first: try doubling lengths to bound the search.
  let probe = 16;
  while (probe < hi) {
    try {
      const out = inflateSync(pack.subarray(off, off + probe));
      if (out.length === size) {
        hi = probe;
        break;
      }
      if (out.length > size) break;
    } catch {
      // not complete yet
    }
    probe *= 2;
  }
  if (probe < hi) hi = probe;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(pack.subarray(off, off + mid));
      if (out.length === size) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

// ---------- packfile writing ----------
export function collectReachable(repo: Repo, wants: string[], haves: Set<string>, shallow: Set<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const haveAncestors = new Set<string>();
  // Everything reachable from a have is excluded.
  const markHave = (sha: string) => {
    const stack = [sha];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (haveAncestors.has(cur)) continue;
      haveAncestors.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj) continue;
      if (obj.type === "commit") {
        const { tree, parents } = parseCommit(obj.data);
        stack.push(tree);
        for (const p of parents) stack.push(p);
      } else if (obj.type === "tree") {
        for (const e of parseTree(obj.data)) stack.push(e.sha);
      }
    }
  };
  for (const h of haves) markHave(h);
  const visit = (sha: string, depth: number) => {
    if (haveAncestors.has(sha) || out.has(sha)) return;
    const obj = repo.objects.get(sha);
    if (!obj) return;
    out.set(sha, obj);
    if (obj.type === "commit") {
      const { tree, parents } = parseCommit(obj.data);
      visit(tree, depth);
      if (!shallow.has(sha)) {
        for (const p of parents) visit(p, depth + 1);
      }
    } else if (obj.type === "tree") {
      for (const e of parseTree(obj.data)) visit(e.sha, depth);
    }
  };
  for (const w of wants) visit(w, 0);
  return out;
}

export function buildPack(objects: Map<string, GitObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.size, 8);
  parts.push(header);
  const typeNums: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  // Deterministic order: commits first (sorted by sha), then trees, then blobs.
  const sorted = [...objects.entries()].sort((a, b) => {
    const ta = typeNums[a[1].type] - typeNums[b[1].type];
    return ta !== 0 ? ta : a[0] < b[0] ? -1 : 1;
  });
  for (const [, obj] of sorted) {
    const typeNum = typeNums[obj.type];
    const size = obj.data.length;
    const hdr: number[] = [];
    let b = (typeNum << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) b |= 0x80;
    hdr.push(b);
    while (rest > 0) {
      let nb = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) nb |= 0x80;
      hdr.push(nb);
    }
    parts.push(Buffer.from(hdr));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash("sha1").update(body).digest();
  return Buffer.concat([body, trailer]);
}

export function refsOf(repo: Repo): { name: string; sha: string }[] {
  const refs: { name: string; sha: string }[] = [];
  const branches = [...repo.branches.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, sha] of branches) {
    refs.push({ name: "refs/heads/" + name, sha });
  }
  const head = repo.branches.get(repo.defaultBranch);
  if (head) refs.push({ name: "HEAD", sha: head });
  return refs;
}

export function looseObjectBytes(obj: GitObject): Buffer {
  const header = Buffer.from(obj.type + " " + obj.data.length + "\0", "utf8");
  return Buffer.concat([header, obj.data]);
}
void looseObjectBytes;
