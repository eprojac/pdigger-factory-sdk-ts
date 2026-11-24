/**
 * Looks (SDK-DESIGN.md 4.6.2): how well one stone's look agrees with another's, the same number in every SDK. The sums
 * are integers well below 2^53, exact in doubles; the only rounded steps are one product under a square root and one
 * division. `lookPairing` gives the score with the pair count of the placement that won, `lookPermille` the integer the
 * tray rules compare, and `usableLook` whether the tray rules use a look (4.6.3).
 */
import type { StoneLook, WorldSpeckle } from "../models.js";

/** Looks are compared at whole-cell shifts of up to this many cells each way ... */
export const LOOK_SHIFT = 3;
/** ... where at least this many cells (and half the smaller look's read cells) pair. */
export const LOOK_MIN = 24;
/** Faces whose sides differ by less than this share are also compared a quarter turn round. */
export const LOOK_SQUARE = 0.12;
/** A look of more cells than this (`nu` x `nv`) is not a look: every sum stays exact in a double. */
export const LOOK_CELLS = 4096;
/** Whole numbers are read from -2^53 to 2^53. */
const WHOLE_MAX = 2 ** 53;

/** A JSON number by value: a finite double, never a boolean or a string. */
const isNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/** A number whose double is an integer from -2^53 to 2^53: 3 and 3.0 are both 3; 1.5 and 2^53 + 2 are not. */
const isWhole = (x: unknown): x is number => isNumber(x) && Number.isInteger(x) && Math.abs(x) <= WHOLE_MAX;
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * A stone's look fits `StoneLook` by value (SDK-DESIGN.md 4.6.2): `sp` and `q` numbers; `v`, `g`, `nu` and `nv` whole
 * numbers; `px` an array of numbers; `at` an object of the numbers `cx`, `cy`, `theta`, `L` and `S`; `d` a string. The
 * other languages' models drop a look that does not fit, and keep its stone and frame.
 */
export function fitsLook(v: unknown): v is StoneLook {
  if (!isObject(v) || !isNumber(v.sp) || !isNumber(v.q) || typeof v.d !== "string") return false;
  if (!isWhole(v.v) || !isWhole(v.g) || !isWhole(v.nu) || !isWhole(v.nv)) return false;
  const { px, at } = v;
  return (
    Array.isArray(px) &&
    px.every(isNumber) &&
    isObject(at) &&
    isNumber(at.cx) &&
    isNumber(at.cy) &&
    isNumber(at.theta) &&
    isNumber(at.L) &&
    isNumber(at.S)
  );
}

const fitsFind = (x: unknown): boolean => {
  if (!isObject(x) || !isWhole(x.id)) return false;
  if (x.at !== null && x.at !== undefined && !isWhole(x.at)) return false;
  const s = x.score ?? null;
  const q = x.second ?? null;
  return (s === null && q === null) || (isNumber(s) && isNumber(q));
};

const fitsMoment = (x: unknown): boolean => isObject(x) && isWhole(x.g) && isNumber(x.t);

/**
 * The unit's speckle answer fits `WorldSpeckle` by value (SDK-DESIGN.md 4.6.12): `v` 1; `tray` a whole number; `ref`
 * and `at` objects of a whole `g` and a number `t`; `device` a string; `gpu_ms` and `wall_ms` numbers; `stones` and
 * `refs` arrays of finds (`id` a whole number, `at` a whole number or null, `score` and `second` both numbers or both
 * null); `pairs` an array of two whole numbers each. The models drop an answer that does not fit, and keep its world.
 */
export function fitsSpeckle(v: unknown): v is WorldSpeckle {
  if (!isObject(v) || v.v !== 1 || !isWhole(v.tray) || !fitsMoment(v.ref) || !fitsMoment(v.at)) return false;
  if (typeof v.device !== "string" || !isNumber(v.gpu_ms) || !isNumber(v.wall_ms)) return false;
  const { stones, refs, pairs } = v;
  return (
    Array.isArray(stones) &&
    stones.every(fitsFind) &&
    Array.isArray(refs) &&
    refs.every(fitsFind) &&
    Array.isArray(pairs) &&
    pairs.every((p) => Array.isArray(p) && p.length === 2 && p.every(isWhole))
  );
}

type Rows = number[][];

/** A look's cells as rows: values (0 where not read), read marks (1 or 0) and squared values. */
interface Grid {
  v: Rows;
  m: Rows;
  vv: Rows;
}

/** A look the rules can read. */
export interface LookCells {
  g: number;
  square: boolean;
  n: number;
  grid: Grid;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Canonical base64 of bytes (RFC 4648, padded). */
function encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)]! : "=";
    out += i + 2 < bytes.length ? B64[c & 63]! : "=";
  }
  return out;
}

/**
 * The bytes of canonical base64 text whose length is a multiple of 4 (readLook checks it first); null for anything
 * else (another alphabet, padding, characters or stray bits).
 */
function decode(text: string): Uint8Array | null {
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let k = 0;
  for (let i = 0; i < text.length; i += 4) {
    let word = 0;
    for (let j = 0; j < 4; j++) {
      const ch = text[i + j]!;
      const x = ch === "=" && i + 4 === text.length && j >= 4 - pad ? 0 : B64.indexOf(ch);
      if (x < 0) return null;
      word = word * 64 + x;
    }
    for (const shift of [16, 8, 0]) if (k < out.length) out[k++] = (word >> shift) & 255;
  }
  return encode(out) === text ? out : null;
}

/**
 * The cells of a look; null when the rules cannot read it (one that does not fit `StoneLook` by value, another
 * version, more than {@link LOOK_CELLS} cells, cells that are not canonical base64 of `nu` x `nv` bytes).
 */
export function readLook(lk: unknown): LookCells | null {
  if (!fitsLook(lk) || lk.v !== 1 || lk.nu < 1 || lk.nv < 1 || lk.nu * lk.nv > LOOK_CELLS) return null;
  if (lk.d.length !== 4 * Math.ceil((lk.nu * lk.nv) / 3)) return null; // not the length of nu x nv bytes: not decoded
  const raw = decode(lk.d);
  if (raw === null || raw.length !== lk.nu * lk.nv) return null;
  const { nu, nv } = lk;
  const grid: Grid = { v: [], m: [], vv: [] };
  let n = 0;
  for (let j = 0; j < nv; j++) {
    const v = new Array<number>(nu).fill(0);
    const m = new Array<number>(nu).fill(0);
    const vv = new Array<number>(nu).fill(0);
    for (let i = 0; i < nu; i++) {
      const b = raw[j * nu + i]!;
      const x = b > 127 ? b - 256 : b;
      if (x !== -128) {
        v[i] = x;
        m[i] = 1;
        vv[i] = x * x;
        n++;
      }
    }
    grid.v.push(v);
    grid.m.push(m);
    grid.vv.push(vv);
  }
  const big = Math.max(lk.at.L, lk.at.S);
  const small = Math.min(lk.at.L, lk.at.S);
  return { g: lk.g, square: big > 0 && (big - small) / big < LOOK_SQUARE, n, grid };
}

function turnRows(rows: Rows, q: number): Rows {
  const nv = rows.length;
  const nu = rows[0]!.length;
  const out: Rows = [];
  if (q === 2) {
    for (let j = 0; j < nv; j++) {
      const r: number[] = [];
      for (let i = 0; i < nu; i++) r.push(rows[nv - 1 - j]![nu - 1 - i]!);
      out.push(r);
    }
    return out;
  }
  for (let r = 0; r < nu; r++) {
    const row: number[] = [];
    for (let c = 0; c < nv; c++) row.push(q === 1 ? rows[c]![nu - 1 - r]! : rows[nv - 1 - c]![r]!);
    out.push(row);
  }
  return out;
}

const turned = (g: Grid, q: number): Grid => ({ v: turnRows(g.v, q), m: turnRows(g.m, q), vv: turnRows(g.vv, q) });

/** The six integer sums of a's cells against b's, a's cell (0, 0) on b's cell (ov, ou). */
function sums(a: Grid, b: Grid, ov: number, ou: number): [number, number, number, number, number, number] {
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  const i0 = Math.max(0, -ou);
  const i1 = Math.min(a.v[0]!.length, b.v[0]!.length - ou);
  const j1 = Math.min(a.v.length, b.v.length - ov);
  for (let j = Math.max(0, -ov); j < j1; j++) {
    const av = a.v[j]!;
    const am = a.m[j]!;
    const aa = a.vv[j]!;
    const bv = b.v[j + ov]!;
    const bm = b.m[j + ov]!;
    const bb = b.vv[j + ov]!;
    for (let i = i0; i < i1; i++) {
      const k = i + ou;
      n += am[i]! * bm[k]!;
      sa += av[i]! * bm[k]!;
      sb += bv[k]! * am[i]!;
      saa += aa[i]! * bm[k]!;
      sbb += bb[k]! * am[i]!;
      sab += av[i]! * bv[k]!;
    }
  }
  return [n, sa, sb, saa, sbb, sab];
}

/** The normalised cross-correlation of the sums; null below `need` pairs or for a flat side. */
function zncc(
  [n, sa, sb, saa, sbb, sab]: [number, number, number, number, number, number],
  need: number,
): number | null {
  if (n < need) return null;
  const da = n * saa - sa * sa;
  const db = n * sbb - sb * sb;
  if (da <= 0 || db <= 0) return null;
  return (n * sab - sa * sb) / Math.sqrt(da * db);
}

const span = (h: number): number[] => (h > 0 ? [0, 1] : h < 0 ? [-1, 0] : [0]);

/** b sampled half a cell from (ov, ou) toward (hv, hu): each cell the sum of the 2 or 4 cells around, all read. */
function halfGrid(b: Grid, nv: number, nu: number, ov: number, ou: number, hv: number, hu: number): Grid {
  const nvb = b.v.length;
  const nub = b.v[0]!.length;
  const h: Grid = { v: [], m: [], vv: [] };
  for (let j = 0; j < nv; j++) {
    const v = new Array<number>(nu).fill(0);
    const m = new Array<number>(nu).fill(0);
    const vv = new Array<number>(nu).fill(0);
    for (let i = 0; i < nu; i++) {
      let s = 0;
      let ok = true;
      for (const a of span(hv)) {
        for (const c of span(hu)) {
          const y = j + ov + a;
          const x = i + ou + c;
          if (y >= 0 && y < nvb && x >= 0 && x < nub && b.m[y]![x] === 1) s += b.v[y]![x]!;
          else ok = false;
        }
      }
      if (ok) {
        v[i] = s;
        m[i] = 1;
        vv[i] = s * s;
      }
    }
    h.v.push(v);
    h.m.push(m);
    h.vv.push(vv);
  }
  return h;
}

/**
 * The cells of a look the tray rules use (SDK-DESIGN.md 4.6.3): one {@link readLook} reads, with pitch `sp` 2 and
 * scale `q` 32, at least 3 x 3 cells, both sides of its face above 0 and at least {@link LOOK_MIN} cells read; else
 * null.
 */
export function usableCells(lk: unknown): LookCells | null {
  const c = readLook(lk);
  if (c === null) return null;
  const { sp, q, nu, nv, at } = lk as StoneLook;
  return sp === 2 && q === 32 && nu >= 3 && nv >= 3 && at.L > 0 && at.S > 0 && c.n >= LOOK_MIN ? c : null;
}

/**
 * The tray rules use this look (SDK-DESIGN.md 4.6.3): it reads, with pitch `sp` 2 and scale `q` 32, at least 3 x 3
 * cells, both sides of its face above 0 and at least {@link LOOK_MIN} cells read.
 */
export function usableLook(lk: StoneLook | null | undefined): boolean {
  return usableCells(lk) !== null;
}

/** A score as the integer the tray rules compare: `floor(score * 1000 + 0.5)` (an IEEE multiply, then an add). */
export function lookPermille(score: number): number {
  return Math.floor(score * 1000 + 0.5);
}

/** `lookPairing` of two read looks: the score and the pair count of the placement that gave it. */
export function pairCells(a: LookCells, b: LookCells): [number, number] | null {
  const need = Math.max(LOOK_MIN, Math.floor((Math.min(a.n, b.n) + 1) / 2));
  const nva = a.grid.v.length;
  const nua = a.grid.v[0]!.length;
  const turns = [b.grid, turned(b.grid, 2)];
  if (a.square && b.square) turns.push(turned(b.grid, 1), turned(b.grid, 3));
  let best: [number, number] | null = null;
  for (const t of turns) {
    const ov = Math.floor((t.v.length - nva) / 2); // the floor of the centre offset
    const ou = Math.floor((t.v[0]!.length - nua) / 2);
    let top: number | null = null;
    let tn = 0;
    let tv = 0;
    let tu = 0;
    for (let dv = -LOOK_SHIFT; dv <= LOOK_SHIFT; dv++) {
      for (let du = -LOOK_SHIFT; du <= LOOK_SHIFT; du++) {
        const s = sums(a.grid, t, ov + dv, ou + du);
        const z = zncc(s, need);
        if (z !== null && (top === null || z > top)) {
          top = z;
          tn = s[0];
          tv = dv;
          tu = du;
        }
      }
    }
    if (top === null) continue;
    // half-cell shifts: each cell the sum of the 2 or 4 cells of b around the half position, all read
    for (let hv = -1; hv <= 1; hv++) {
      for (let hu = -1; hu <= 1; hu++) {
        if (hu === 0 && hv === 0) continue;
        const s = sums(a.grid, halfGrid(t, nva, nua, ov + tv, ou + tu, hv, hu), 0, 0);
        const z = zncc(s, need);
        if (z !== null && z > top) {
          top = z;
          tn = s[0];
        }
      }
    }
    if (best === null || top > best[0]) best = [top, tn];
  }
  return best;
}

/**
 * How well look `a` agrees with look `b` (SDK-DESIGN.md 4.6.2): the best normalised cross-correlation of a's read
 * cells with b's over b's turns (half a turn round, and a quarter and three quarters round when both faces are near
 * square), whole-cell shifts of up to 3 cells and then half-cell shifts around each turn's best, from exact integer
 * sums: the same number in every SDK. 1 is the same texture; other stones score about 0.2 to 0.4. Null when either is
 * not a look the rules can read or no placement pairs enough cells (24, and half the smaller look's read cells).
 */
export function lookScore(a: StoneLook | null | undefined, b: StoneLook | null | undefined): number | null {
  const r = lookPairing(a, b);
  return r === null ? null : r[0];
}

/**
 * `lookScore(a, b)` with `n`, the pair count of the placement that gave it (SDK-DESIGN.md 4.6.2): `[score, n]`, null
 * exactly when the score is null.
 */
export function lookPairing(a: StoneLook | null | undefined, b: StoneLook | null | undefined): [number, number] | null {
  const x = readLook(a);
  const y = readLook(b);
  return x === null || y === null ? null : pairCells(x, y);
}
