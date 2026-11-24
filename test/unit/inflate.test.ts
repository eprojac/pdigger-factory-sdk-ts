import { constants, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, gunzip, inflateRaw, inflateZlib, isGzip } from "../../src/internal/inflate.js";

/** Writes DEFLATE bit streams: fields LSB first, Huffman codes MSB first. */
class Bits {
  private readonly out: number[] = [];
  private cur = 0;
  private n = 0;
  put(value: number, count: number): this {
    for (let i = 0; i < count; i++) {
      this.cur |= ((value >> i) & 1) << this.n;
      if (++this.n === 8) {
        this.out.push(this.cur);
        this.cur = 0;
        this.n = 0;
      }
    }
    return this;
  }
  code(code: number, len: number): this {
    for (let i = len - 1; i >= 0; i--) this.put((code >> i) & 1, 1);
    return this;
  }
  bytes(...extra: number[]): Uint8Array {
    const out = [...this.out];
    if (this.n > 0) out.push(this.cur);
    return new Uint8Array([...out, ...extra]);
  }
}

const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A dynamic block header: HLIT, HDIST and the code-length code lengths of the given symbols. */
function dynamic(nlen: number, ndist: number, clens: Record<number, number>): Bits {
  const b = new Bits()
    .put(1, 1)
    .put(2, 2)
    .put(nlen - 257, 5)
    .put(ndist - 1, 5);
  let ncode = 4;
  for (let i = 0; i < ORDER.length; i++) if ((clens[ORDER[i] as number] ?? 0) > 0) ncode = Math.max(ncode, i + 1);
  b.put(ncode - 4, 4);
  for (let i = 0; i < ncode; i++) b.put(clens[ORDER[i] as number] ?? 0, 3);
  return b;
}

const text = new TextEncoder().encode(
  "The stone is lifted, carried and set down again. ".repeat(40) + "Each SDK prints the same sentences. 0123456789",
);

describe("inflate", () => {
  it("inflates stored, fixed and dynamic blocks", () => {
    expect(inflateRaw(deflateRawSync(text, { level: 0 })).bytes).toEqual(new Uint8Array(text));
    expect(inflateRaw(deflateRawSync(text, { strategy: constants.Z_FIXED })).bytes).toEqual(new Uint8Array(text));
    expect(inflateRaw(deflateRawSync(text)).bytes).toEqual(new Uint8Array(text));
    const zeros = new Uint8Array(200_000);
    expect(inflateRaw(deflateRawSync(zeros)).bytes).toEqual(zeros);
    const random = new Uint8Array(70_000).map((_x, i) => (i * 2654435761) >>> 24);
    expect(inflateRaw(deflateRawSync(random)).bytes).toEqual(random);
    expect(inflateZlib(deflateSync(text))).toEqual(new Uint8Array(text));
    // a block of literals only: every distance length is zero
    const literals = dynamic(257, 1, { 0: 2, 1: 2, 2: 2, 18: 2 })
      .code(0b01, 2)
      .code(0b11, 2)
      .put(127, 7)
      .code(0b11, 2)
      .put(106, 7)
      .code(0b01, 2)
      .code(0b00, 2)
      .code(0, 1)
      .code(1, 1);
    expect([...inflateRaw(literals.bytes()).bytes]).toEqual([0]);
  });

  it("rejects malformed DEFLATE data", () => {
    const fails = (data: Uint8Array, message: string): void => expect(() => inflateRaw(data)).toThrow(message);
    fails(new Uint8Array(0), "unexpected end of data");
    fails(new Bits().put(1, 1).put(0, 2).bytes(1), "unexpected end of data");
    fails(new Bits().put(1, 1).put(0, 2).bytes(1, 0, 0, 0), "stored block length mismatch");
    fails(new Bits().put(1, 1).put(0, 2).bytes(5, 0, 0xfa, 0xff, 1, 2), "unexpected end of data");
    fails(new Bits().put(1, 1).put(3, 2).bytes(), "invalid block type");
    fails(new Bits().put(1, 1).put(1, 2).code(0b11000110, 8).bytes(), "invalid length symbol");
    // fixed distance code 30 does not exist: no code matches
    fails(new Bits().put(1, 1).put(1, 2).code(0b0000001, 7).code(0b11110, 5).bytes(0xff, 0xff), "invalid Huffman code");
    fails(new Bits().put(1, 1).put(1, 2).code(0b0000001, 7).code(0, 5).bytes(0), "distance too far back");
    fails(new Bits().put(1, 1).put(2, 2).put(30, 5).put(0, 5).put(0, 4).bytes(0, 0), "bad counts");
    fails(dynamic(257, 1, { 16: 1 }).bytes(0, 0), "incomplete code-length code");
    fails(dynamic(257, 1, { 0: 1, 16: 1 }).code(1, 1).bytes(0, 0), "repeat with no first length");
    fails(
      dynamic(257, 1, { 0: 1, 18: 1 }).code(1, 1).put(127, 7).code(1, 1).put(127, 7).bytes(0, 0),
      "too many lengths",
    );
    fails(
      dynamic(257, 1, { 0: 1, 18: 1 }).code(1, 1).put(127, 7).code(1, 1).put(109, 7).bytes(0, 0),
      "no end-of-block code",
    );
    // code lengths 0 -> 00, 1 -> 01, 2 -> 10, 18 -> 11
    const lens = (): Bits =>
      dynamic(257, 2, { 0: 2, 1: 2, 2: 2, 18: 2 }).code(0b01, 2).code(0b11, 2).put(127, 7).code(0b11, 2).put(106, 7);
    fails(lens().code(0b10, 2).code(0b01, 2).code(0b01, 2).bytes(0, 0), "incomplete literal/length code");
    const over = dynamic(257, 2, { 0: 2, 1: 2, 2: 2, 18: 2 })
      .code(0b01, 2)
      .code(0b01, 2)
      .code(0b11, 2)
      .put(127, 7)
      .code(0b11, 2)
      .put(105, 7)
      .code(0b01, 2)
      .code(0b01, 2)
      .code(0b01, 2);
    fails(over.bytes(0, 0), "incomplete literal/length code");
    fails(lens().code(0b01, 2).code(0b01, 2).code(0b10, 2).bytes(0, 0), "incomplete distance code");
  });

  it("checks the zlib wrapper", () => {
    const z = deflateSync(text);
    expect(() => inflateZlib(new Uint8Array(3))).toThrow("zlib stream too short");
    expect(() => inflateZlib(new Uint8Array([0x79, 0x9c, 0, 0, 0, 0]))).toThrow("not a zlib stream");
    expect(() => inflateZlib(new Uint8Array([0x78, 0x9d, 0, 0, 0, 0]))).toThrow("not a zlib stream");
    expect(() => inflateZlib(new Uint8Array([0x78, 0xbb, 0, 0, 0, 0]))).toThrow("preset dictionaries");
    expect(() => inflateZlib(z.subarray(0, z.length - 2))).toThrow("missing Adler-32");
    const bad = new Uint8Array(z);
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    expect(() => inflateZlib(bad)).toThrow("Adler-32 mismatch");
  });

  it("decompresses gzip with header fields and several members", () => {
    expect(gunzip(gzipSync(text))).toEqual(new Uint8Array(text));
    const raw = deflateRawSync(text);
    const crc = crc32(text);
    const le = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
    const member = new Uint8Array([
      0x1f, 0x8b, 8, 0x04 | 0x08 | 0x10 | 0x02, 0, 0, 0, 0, 0, 3,
      2, 0, 0xaa, 0xbb,
      ...new TextEncoder().encode("name.ndjson"), 0,
      ...new TextEncoder().encode("comment"), 0,
      0x12, 0x34,
      ...raw, ...le(crc), ...le(text.length),
    ]); // prettier-ignore
    expect(gunzip(member)).toEqual(new Uint8Array(text));
    const two = new Uint8Array([...gzipSync("ab"), ...gzipSync("cd")]);
    expect(new TextDecoder().decode(gunzip(two))).toBe("abcd");
    expect(isGzip(new Uint8Array([0x1f]))).toBe(false);
  });

  it("rejects malformed gzip", () => {
    const g = gzipSync(text);
    expect(() => gunzip(new Uint8Array(5))).toThrow("not a gzip stream");
    const method = new Uint8Array(g);
    method[2] = 7;
    expect(() => gunzip(method)).toThrow("unknown gzip compression method");
    const name = new Uint8Array([0x1f, 0x8b, 8, 0x08, 0, 0, 0, 0, 0, 3, 65, 66, 67, 68, 69, 70, 71, 72]);
    expect(() => gunzip(name)).toThrow("unterminated gzip header field");
    expect(() => gunzip(g.subarray(0, g.length - 4))).toThrow("missing gzip trailer");
    const crc = new Uint8Array(g);
    crc[crc.length - 8] = (crc[crc.length - 8] as number) ^ 1;
    expect(() => gunzip(crc)).toThrow("CRC-32 mismatch");
    const size = new Uint8Array(g);
    size[size.length - 1] = (size[size.length - 1] as number) ^ 1;
    expect(() => gunzip(size)).toThrow("size mismatch");
  });

  it("computes CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});
