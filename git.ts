// Git object model and the smart-HTTP pack protocol, implemented on node:crypto and
// node:zlib only. No git binary, no dependencies.
//
// Object ids are SHA-1 over `<type> <size>\0` + bytes. Packfiles are written without deltas
// (a plain pack is always accepted); packs read from clients are resolved with REF_DELTA and
// OFS_DELTA support, since real pushes send deltas.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(objects: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// -------------------------------------------------------------------------------------------
// trees and commits
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: GitObjectType; tag: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

const IDENTITY = 'Conformance <conformance@make.fun>';
const FIXED_EPOCH = 1700000000;

export function buildCommit(tree: string, parents: readonly string[], message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${IDENTITY} ${FIXED_EPOCH} +0000`, `committer ${IDENTITY} ${FIXED_EPOCH} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

/** Every object reachable from `roots` (commit -> tree + parents, tree -> entries, tag -> target). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  opts: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (opts.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const header = Buffer.alloc(4);
  header.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Decode a whole buffer of pkt-lines into packets (flush/delim/data). */
export function decodePktLines(bytes: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line');
    const len = parseInt(bytes.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > bytes.length) throw new Error('bad pkt-line length');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return packets;
}

export function pktLinesToText(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over everything before it. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    // Level 1: the client only needs a valid zlib stream, and pack bytes are small;
    // fast compression keeps 50 concurrent clones off the single thread.
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buffer: Buffer, start: number): { size: number; next: number } {
  let byte = buffer[start];
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarintDelta = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readVarintDelta();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarintDelta();
  const parts: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const opcode = delta[offset++];
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (opcode & (1 << i)) copyOffset |= delta[offset++] << (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (opcode & (0x10 << i)) copySize |= delta[offset++] << (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (opcode !== 0) {
      parts.push(delta.subarray(offset, offset + opcode));
      offset += opcode;
      total += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

export interface PackEntry {
  readonly offset: number;
  readonly type: GitObjectType;
  readonly data: Buffer;
  readonly oid: string;
}

/** Parse a packfile, resolving OFS_DELTA and REF_DELTA entries. `resolveBase` finds objects the pack references from outside (thin packs). */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  interface Pending { offset: number; kind: 'ofs' | 'ref'; base: number | string; data: Buffer; }
  const pending: Pending[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const { size, next } = readVarint(pack, offset);
    const first = pack[offset];
    const typeCode = (first >> 4) & 0x07;
    offset = next;
    if (typeCode === 6) {
      const { baseOffset, next: afterBase } = readOfsDeltaBase(pack, offset);
      const { data, next: afterData } = inflateAt(pack, afterBase);
      pending.push({ offset: entryOffset, kind: 'ofs', base: entryOffset - baseOffset, data });
      offset = afterData;
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data, next: afterData } = inflateAt(pack, offset);
      pending.push({ offset: entryOffset, kind: 'ref', base: baseOid, data });
      offset = afterData;
    } else {
      const type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, next: afterData } = inflateAt(pack, offset);
      if (data.length !== size) throw new Error('pack object size mismatch');
      const oid = hashObject(type, data);
      const obj = { type, data };
      objects.set(oid, obj);
      byOffset.set(entryOffset, obj);
      offset = afterData;
    }
  }
  // Resolve deltas; a delta's base may itself be a delta, so loop until none remain.
  let remaining = pending;
  while (remaining.length) {
    const nextPending: Pending[] = [];
    let progressed = false;
    for (const entry of remaining) {
      let baseObj: GitObject | undefined;
      if (entry.kind === 'ofs') baseObj = byOffset.get(entry.base as number);
      else baseObj = objects.get(entry.base as string) ?? resolveBase?.(entry.base as string);
      if (!baseObj) {
        nextPending.push(entry);
        continue;
      }
      const data = applyDelta(baseObj.data, entry.data);
      const oid = hashObject(baseObj.type, data);
      const obj = { type: baseObj.type, data };
      objects.set(oid, obj);
      byOffset.set(entry.offset, obj);
      progressed = true;
    }
    if (!progressed) throw new Error('pack delta base is missing');
    remaining = nextPending;
  }
  return objects;
}

/** Split a pack into sideband band-1 pkt-lines (max payload per pkt-line). */
export function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const MAX = 65516 - 1;
  for (let offset = 0; offset < pack.length; offset += MAX) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + MAX));
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) {
    chunks.push(encodePktLine(Buffer.from([1])));
  }
  return Buffer.concat(chunks);
}
