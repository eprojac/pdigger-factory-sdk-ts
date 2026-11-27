/**
 * The Interpreter's numbers and sentences (SDK-DESIGN.md sections 4.1, 4.2, 4.4, 4.5 and 4.6). Identical in every SDK:
 * never use `toFixed` for text, it rounds ties differently.
 *
 * @module
 */

/** Decimal text of `x` with `d` places: `n = floor(x * 10^d + 0.5)` printed with a decimal point (section 4.5). */
export function fmt(x: number, d: number): string {
  if (x < 0) return `-${fmt(-x, d)}`;
  const n = Math.floor(x * 10 ** d + 0.5);
  const s = String(n);
  if (d === 0) return s;
  const padded = s.padStart(d + 1, "0");
  return `${padded.slice(0, -d)}.${padded.slice(-d)}`;
}

/** `floor(x * 1000 + 0.5) / 1000`, the rounding of the JSON summary. */
export function round3(x: number): number {
  return Math.floor(x * 1000 + 0.5) / 1000;
}

/** Python's integer `%` (the result has the sign of the divisor). */
export function pyMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Python's integer `//` (floor division), exact for integers. */
export function pyDiv(a: number, b: number): number {
  return (a - pyMod(a, b)) / b;
}

/**
 * An integer in permille with three decimals, from integers only: 853 is `0.853`, 1000 is `1.000`, -5 is `-0.005`
 * (SDK-DESIGN.md 4.6.8).
 */
export function milli(p: number): string {
  if (p < 0) return `-${milli(-p)}`;
  return `${pyDiv(p, 1000)}.${String(pyMod(p, 1000)).padStart(3, "0")}`;
}

/** Media time as `M:SS.d` below one hour, `H:MM:SS.d` from one hour (section 4.5). */
export function clock(t: number): string {
  const n = Math.floor(t * 10 + 0.5);
  const h = pyDiv(n, 36000);
  const m = pyMod(pyDiv(n, 600), 60);
  const s = pyMod(pyDiv(n, 10), 60);
  const d = pyMod(n, 10);
  const ss = String(s).padStart(2, "0");
  if (h === 0) return `${m}:${ss}.${d}`;
  return `${h}:${String(m).padStart(2, "0")}:${ss}.${d}`;
}

const HAND_WORDS: Readonly<Record<string, string>> = { left: "Left hand", right: "Right hand", both: "Both hands" };

/** The own string property `key` of `table`, or undefined (never an inherited `toString`). */
function ownString(table: Readonly<Record<string, string>>, key: string | null | undefined): string | undefined {
  return key != null && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** `Left hand`, `Right hand`, `Both hands`, or `A hand` for no side. */
export function handWord(side: string | null | undefined): string {
  return ownString(HAND_WORDS, side) ?? "A hand";
}

/** Third person singular verbs and their plural for `Both hands`. */
const VERBS: Record<string, string> = {
  pushes: "push",
  lifts: "lift",
  tips: "tip",
  carries: "carry",
  places: "place",
  drops: "drop",
  takes: "take",
  moves: "move",
  is: "are",
};

/** The verb agreeing with the hand: plural for `both`. */
export function verb(side: string | null | undefined, word: keyof typeof VERBS): string {
  return side === "both" ? (VERBS[word] as string) : word;
}

/** The reasons of a `delete`, in words. */
export const DELETE_REASONS: Readonly<Record<string, string>> = {
  absent: "no longer seen",
  overlap: "overlapped another stone",
  outside: "outside the board",
  merged: "merged with a neighbour",
  empty: "its place is empty",
  hand: "a hand emptied its place",
  "carried-away": "carried away",
  sheet: "gone from under a sheet",
};

function idStr(id: number | null | undefined): string {
  return id == null ? "?" : String(id);
}

/** `a`, `a and b`, `a, b and c`. */
export function joinIds(ids: readonly (number | string)[]): string {
  const s = ids.map(String);
  if (s.length <= 1) return s.join("");
  return `${s.slice(0, -1).join(", ")} and ${s[s.length - 1] as string}`;
}

function stoneNames(ids: readonly (string | number)[]): string {
  if (ids.length === 0) return "stone ?";
  if (ids.length === 1) return `stone ${String(ids[0])}`;
  if (ids.length <= 6) return "stones " + joinIds(ids);
  return `stones ${ids.slice(0, 6).map(String).join(", ")} and ${ids.length - 6} more`;
}

/** The fields of an event that its sentence reads. */
export interface EventText {
  ids?: readonly number[] | null;
  type: string;
  t: number;
  stoneId: number | null;
  hand: string | null;
  why: string | null;
  into: readonly number[] | null;
  source: string | null;
}

/** The sentence of an event, without the clock (section 4.1). */
export function eventSentence(e: EventText): string {
  const i = idStr(e.stoneId);
  const side = e.hand;
  const H = handWord(side);
  const v = (w: keyof typeof VERBS): string => verb(side, w);
  switch (e.type) {
    case "new":
      return `stone ${i} appears${e.source === "image" ? " (found in the image)" : ""}`;
    case "confirm":
      return `stone ${i} is confirmed`;
    case "freeze":
      return `stone ${i} gets its final shape`;
    case "push":
      if (e.why === "course") return `stone ${i} is pushed along its row`;
      if (e.why === "reseat") return `stone ${i} is reseated`;
      if (side) return `${H} ${v("pushes")} stone ${i}`;
      return `stone ${i} is pushed${e.why ? ` (${e.why})` : ""}`;
    case "lift":
      return `${H} ${v("lifts")} stone ${i}`;
    case "hinge":
      return `${H} ${v("tips")} stone ${i} up on its edge`;
    case "carry":
      return `${H} ${v("carries")} stone ${i}`;
    case "place":
      return `${H} ${v("places")} stone ${i}`;
    case "drop":
      return `${H} ${v("drops")} stone ${i}`;
    case "gone":
      return `${H} ${v("takes")} stone ${i} out of view`;
    case "delete":
      if (e.why == null) return `stone ${i} is removed`;
      return `stone ${i} is removed (${ownString(DELETE_REASONS, e.why) ?? e.why})`;
    case "sheet": {
      if (e.why !== "laid" && e.why !== "lifted") return "a sheet event" + (e.why ? " (" + e.why + ")" : "");
      const prep = e.why === "laid" ? " over " : " off ";
      return "a sheet is " + e.why + (e.ids?.length ? prep + stoneNames(e.ids) : "");
    }
    case "split": {
      const into = e.into;
      if (into == null || into.length === 0) return `stone ${i} splits`;
      if (into.length === 1) return `stone ${i} is trimmed`;
      return `stone ${i} splits into ${joinIds(into)}`;
    }
    default:
      return `stone ${i}: ${e.type}`;
  }
}

/** `{clock} {sentence}` of an event. */
export function describeEvent(e: EventText): string {
  return `${clock(e.t)} ${eventSentence(e)}`;
}

/** The fields of an activity that its sentence reads. */
export interface ActivityText {
  kind: "move" | "push";
  hand: string | null;
  start: { t: number };
  end: { t: number };
  duration: number;
  stoneId?: number | null;
  stones?: readonly number[];
  pushes?: number;
  outcome?: string | null;
  carried?: boolean;
  tipped?: boolean;
  partial?: boolean;
  distance?: number | null;
}

/** The sentence of a move or a push burst, with its clock (section 4.2). */
export function describeActivity(a: ActivityText): string {
  const side = a.hand;
  const H = handWord(side);
  const v = (w: keyof typeof VERBS): string => verb(side, w);
  if (a.kind === "push") {
    const ids = a.stones ?? [];
    const what = stoneNames(ids);
    const n = a.pushes ?? 0;
    const tail = n === 1 ? "(1 push)" : `(${n} pushes in ${fmt(a.duration, 1)} s)`;
    return `${clock(a.start.t)} ${H} ${v("pushes")} ${what} ${tail}`;
  }
  const i = idStr(a.stoneId);
  const dur = fmt(a.duration, 1);
  let s: string;
  switch (a.outcome) {
    case "placed":
      if (a.carried) {
        s =
          a.distance == null
            ? `${H} ${v("moves")} stone ${i} in ${dur} s`
            : `${H} ${v("moves")} stone ${i} ${fmt(a.distance, 2)} units in ${dur} s`;
      } else if (a.tipped) s = `${H} ${v("tips")} stone ${i} and sets it down (${dur} s)`;
      else s = `${H} ${v("lifts")} stone ${i} and sets it down (${dur} s)`;
      break;
    case "dropped":
      s = `${H} ${v("drops")} stone ${i} after ${dur} s`;
      break;
    case "carried_away":
      s = `${H} ${v("takes")} stone ${i} away (${dur} s)`;
      break;
    case "removed":
      s = `${H} ${v("lifts")} stone ${i}; it is removed after ${dur} s`;
      break;
    default:
      s = `${H} ${v("is")} still holding stone ${i} (${dur} s so far)`;
  }
  if (a.partial) return `${clock(a.end.t)} ${s} (joined mid-move)`;
  return `${clock(a.start.t)} ${s}`;
}

/** The fields of a tray fact that its sentence reads. */
export interface TrayFactText {
  trayStones?: readonly string[];
  underSheet?: number | null;
  kind: string;
  tray: number;
  t: number;
  stone: string | null;
  certain: boolean | null;
  why: string | null;
  stones: number | null;
  sure: number | null;
  added: number | null;
  removed: number | null;
  unclear: number | null;
  /** The code of its why (`look_found`, `speckle_same`, ...). */
  code?: string | null;
  /** `unsure`: where its question opened. */
  opened?: { readonly t: number } | null;
  /** `identified`: the world stone it is linked to now, and its score in permille. */
  worldId?: number | null;
  score?: number | null;
}

/** How the leaving's speckle answer identified a stone, by its `identified` fact's code (4.6.13). */
const SPECKLE_HOW: Readonly<Record<string, string>> = {
  speckle_same: "confirmed",
  speckle_moved: "recognised",
  speckle_found: "found again",
};

/** A tray fact's sentence with its clock (section 4.6): `0:45.5 tray 1: stone 20261122T023847.0Z-1-117 was removed`. */
export function describeTrayFact(x: TrayFactText): string {
  const head = `${clock(x.t)} tray ${x.tray}`;
  const n = (v: number | null): number => v ?? 0;
  const id = x.stone ?? "?";
  switch (x.kind) {
    case "arrived":
      return `${head} arrived: ${n(x.stones)} stones`;
    case "sheet":
      return (
        head +
        ": a sheet was " +
        (x.code === "sheet_laid" ? "laid over " : "lifted off ") +
        stoneNames(x.trayStones ?? [])
      );
    case "leaving":
      return (
        `${head} leaving: ${n(x.stones)} stones (${n(x.sure)} sure), ${n(x.added)} added, ${n(x.removed)} removed, ` +
        `${n(x.unclear)} unclear` +
        (x.underSheet ? `, ${x.underSheet} under a sheet` : "")
      );
    case "unsure": {
      const since = x.opened == null ? "" : `; open since ${clock(x.opened.t)}`;
      return `${head}: stone ${id} is not sure any more (${x.why ?? ""}${since})`;
    }
    case "identified": {
      const score = x.score == null ? "-" : milli(x.score);
      const bySpeckle = ownString(SPECKLE_HOW, x.code);
      if (bySpeckle !== undefined) {
        return `${head}: stone ${id} ${bySpeckle} by its speckle on world stone ${String(x.worldId)} (${score})`;
      }
      const how = x.code === "look_found" ? "found again" : "recognised";
      return `${head}: stone ${id} ${how} by its look on world stone ${String(x.worldId)} (${score})`;
    }
    case "removed":
      if (x.certain !== true) return `${head}: stone ${id} not found (unclear)`;
      return `${head}: stone ${id} was removed${x.why === "carried away" ? " (carried away)" : ""}`;
    default:
      return x.certain === true ? `${head}: stone ${id} was set down` : `${head}: stone ${id} not recognised (unclear)`;
  }
}
