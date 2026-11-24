/**
 * A small synchronous DEFLATE decoder (RFC 1951) with the zlib (RFC 1950) and gzip (RFC 1952) wrappers, in plain
 * TypeScript, so that sip1 maps decode synchronously in every runtime (browsers have only the async
 * `DecompressionStream`). It is an altered TypeScript translation of zlib's `puff.c` (Mark Adler, zlib License; see
 * NOTICE): correct and compact rather than fast, which is plenty for 40 x 64 maps.
 */
import { FactoryError } from "../errors.js";

const MAXBITS = 15;
const LBASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function fail(message: string): never {
  throw new FactoryError({ code: "decode", message: `inflate: ${message}` });
}

interface Huffman {
  count: Int16Array;
  symbol: Int16Array;
}

class Inflater {
  private bitBuf = 0;
  private bitCnt = 0;
  private out: Uint8Array;
  private outLen = 0;

  constructor(
    private readonly data: Uint8Array,
    public pos: number,
  ) {
    this.out = new Uint8Array(Math.max(1024, data.length * 4));
  }

  private bits(need: number): number {
    let val = this.bitBuf;
    while (this.bitCnt < need) {
      if (this.pos >= this.data.length) fail("unexpected end of data");
      val |= (this.data[this.pos++] as number) << this.bitCnt;
      this.bitCnt += 8;
    }
    this.bitBuf = val >>> need;
    this.bitCnt -= need;
    return val & ((1 << need) - 1);
  }

  private ensure(extra: number): void {
    if (this.outLen + extra <= this.out.length) return;
    const next = new Uint8Array(Math.max(this.out.length * 2, this.outLen + extra));
    next.set(this.out.subarray(0, this.outLen));
    this.out = next;
  }

  private stored(): void {
    this.bitBuf = 0;
    this.bitCnt = 0;
    if (this.pos + 4 > this.data.length) fail("unexpected end of data");
    const d = this.data;
    const len = (d[this.pos] as number) | ((d[this.pos + 1] as number) << 8);
    const nlen = (d[this.pos + 2] as number) | ((d[this.pos + 3] as number) << 8);
    this.pos += 4;
    if (len !== (~nlen & 0xffff)) fail("stored block length mismatch");
    if (this.pos + len > d.length) fail("unexpected end of data");
    this.ensure(len);
    this.out.set(d.subarray(this.pos, this.pos + len), this.outLen);
    this.outLen += len;
    this.pos += len;
  }

  private decode(h: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAXBITS; len++) {
      code |= this.bits(1);
      const count = h.count[len] as number;
      if (code - count < first) return h.symbol[index + (code - first)] as number;
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    return fail("invalid Huffman code");
  }

  private codes(lencode: Huffman, distcode: Huffman): void {
    for (;;) {
      let sym = this.decode(lencode);
      if (sym < 256) {
        this.ensure(1);
        this.out[this.outLen++] = sym;
        continue;
      }
      if (sym === 256) return;
      sym -= 257;
      if (sym >= 29) fail("invalid length symbol");
      const len = (LBASE[sym] as number) + this.bits(LEXT[sym] as number);
      const dsym = this.decode(distcode); // < 30: both distance codes have at most 30 symbols
      const dist = (DBASE[dsym] as number) + this.bits(DEXT[dsym] as number);
      if (dist > this.outLen) fail("distance too far back");
      this.ensure(len);
      for (let i = 0; i < len; i++) {
        this.out[this.outLen] = this.out[this.outLen - dist] as number;
        this.outLen++;
      }
    }
  }

  private fixed(): void {
    const lengths = new Int16Array(288);
    lengths.fill(8, 0, 144);
    lengths.fill(9, 144, 256);
    lengths.fill(7, 256, 280);
    lengths.fill(8, 280, 288);
    const lencode = huffman(288);
    const distLengths = new Int16Array(30).fill(5);
    const distcode = huffman(30);
    construct(lencode, lengths, 288);
    construct(distcode, distLengths, 30);
    this.codes(lencode, distcode);
  }

  private dynamic(): void {
    const nlen = this.bits(5) + 257;
    const ndist = this.bits(5) + 1;
    const ncode = this.bits(4) + 4;
    if (nlen > 286 || ndist > 30) fail("bad counts");
    const lengths = new Int16Array(320);
    for (let i = 0; i < ncode; i++) lengths[ORDER[i] as number] = this.bits(3);
    const lencode = huffman(19);
    if (construct(lencode, lengths, 19) !== 0) fail("incomplete code-length code");
    lengths.fill(0);
    let index = 0;
    while (index < nlen + ndist) {
      let sym = this.decode(lencode);
      if (sym < 16) {
        lengths[index++] = sym;
        continue;
      }
      let len = 0;
      if (sym === 16) {
        if (index === 0) fail("repeat with no first length");
        len = lengths[index - 1] as number;
        sym = 3 + this.bits(2);
      } else if (sym === 17) {
        sym = 3 + this.bits(3);
      } else {
        sym = 11 + this.bits(7);
      }
      if (index + sym > nlen + ndist) fail("too many lengths");
      while (sym-- > 0) lengths[index++] = len;
    }
    if (lengths[256] === 0) fail("no end-of-block code");
    const lit = lengths.subarray(0, nlen);
    const lcode = huffman(nlen);
    let err = construct(lcode, lit, nlen);
    if (err < 0 || (err > 0 && nlen - (lcode.count[0] as number) !== 1)) fail("incomplete literal/length code");
    const dist = lengths.subarray(nlen, nlen + ndist);
    const dcode = huffman(ndist);
    err = construct(dcode, dist, ndist);
    if (err < 0 || (err > 0 && ndist - (dcode.count[0] as number) !== 1)) fail("incomplete distance code");
    this.codes(lcode, dcode);
  }

  /** Inflates blocks until the last one; returns the output. `pos` is left after the deflate stream. */
  run(): Uint8Array {
    let last = 0;
    do {
      last = this.bits(1);
      const type = this.bits(2);
      if (type === 0) this.stored();
      else if (type === 1) this.fixed();
      else if (type === 2) this.dynamic();
      else fail("invalid block type");
    } while (last === 0);
    return this.out.slice(0, this.outLen);
  }
}

function huffman(n: number): Huffman {
  return { count: new Int16Array(MAXBITS + 1), symbol: new Int16Array(n) };
}

/** Builds the canonical code; returns 0 when complete, < 0 when over-subscribed, > 0 when incomplete. */
function construct(h: Huffman, length: Int16Array, n: number): number {
  h.count.fill(0);
  for (let s = 0; s < n; s++) {
    const l = length[s] as number;
    h.count[l] = (h.count[l] as number) + 1;
  }
  if (h.count[0] === n) return 0;
  let left = 1;
  for (let len = 1; len <= MAXBITS; len++) {
    left <<= 1;
    left -= h.count[len] as number;
    if (left < 0) return left;
  }
  const offs = new Int16Array(MAXBITS + 1);
  for (let len = 1; len < MAXBITS; len++) offs[len + 1] = (offs[len] as number) + (h.count[len] as number);
  for (let s = 0; s < n; s++) {
    const l = length[s] as number;
    if (l !== 0) {
      const at = offs[l] as number;
      h.symbol[at] = s;
      offs[l] = at + 1;
    }
  }
  return left;
}

/** Inflates a raw DEFLATE stream starting at `start`; returns the bytes and the position after the stream. */
export function inflateRaw(data: Uint8Array, start = 0): { bytes: Uint8Array; end: number } {
  const inf = new Inflater(data, start);
  const bytes = inf.run();
  return { bytes, end: inf.pos };
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + (bytes[i] as number)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

let CRC_TABLE: Uint32Array | null = null;

/** CRC-32 (IEEE) of bytes. */
export function crc32(bytes: Uint8Array): number {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Inflates a zlib stream (RFC 1950), checking its header and Adler-32. */
export function inflateZlib(data: Uint8Array): Uint8Array {
  if (data.length < 6) fail("zlib stream too short");
  const cmf = data[0] as number;
  const flg = data[1] as number;
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) fail("not a zlib stream");
  if (flg & 0x20) fail("preset dictionaries are not supported");
  const { bytes, end } = inflateRaw(data, 2);
  if (end + 4 > data.length) fail("missing Adler-32");
  const want =
    (((data[end] as number) << 24) |
      ((data[end + 1] as number) << 16) |
      ((data[end + 2] as number) << 8) |
      (data[end + 3] as number)) >>>
    0;
  if (adler32(bytes) !== want) fail("Adler-32 mismatch");
  return bytes;
}

/** True when the bytes start with the gzip magic. */
export function isGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

function u32le(d: Uint8Array, at: number): number {
  return (
    ((d[at] as number) |
      ((d[at + 1] as number) << 8) |
      ((d[at + 2] as number) << 16) |
      ((d[at + 3] as number) << 24)) >>>
    0
  );
}

/** Decompresses gzip data (RFC 1952), every member, checking CRC-32 and sizes. */
export function gunzip(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let pos = 0;
  do {
    if (data.length - pos < 18 || !isGzip(data.subarray(pos))) fail("not a gzip stream");
    if (data[pos + 2] !== 8) fail("unknown gzip compression method");
    const flags = data[pos + 3] as number;
    pos += 10;
    if (flags & 0x04) {
      const xlen = (data[pos] as number) | ((data[pos + 1] as number) << 8);
      pos += 2 + xlen;
    }
    if (flags & 0x08) pos = skipZeroTerminated(data, pos);
    if (flags & 0x10) pos = skipZeroTerminated(data, pos);
    if (flags & 0x02) pos += 2;
    const { bytes, end } = inflateRaw(data, pos);
    if (end + 8 > data.length) fail("missing gzip trailer");
    if (crc32(bytes) !== u32le(data, end)) fail("gzip CRC-32 mismatch");
    if (bytes.length >>> 0 !== u32le(data, end + 4)) fail("gzip size mismatch");
    parts.push(bytes);
    pos = end + 8;
  } while (pos < data.length && isGzip(data.subarray(pos)));
  if (parts.length === 1) return parts[0] as Uint8Array;
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function skipZeroTerminated(data: Uint8Array, pos: number): number {
  while (pos < data.length && data[pos] !== 0) pos++;
  if (pos >= data.length) fail("unterminated gzip header field");
  return pos + 1;
}
