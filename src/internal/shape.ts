/**
 * What every SDK checks before it takes a stream event or a recording line (SDK-DESIGN.md 2.3 rule 9, section 6): the
 * data is an object, a field that is null counts as missing, and each type has the fields of its table, of their
 * kinds. Further inside (a stone, an event, a hand card, the other layers) TypeScript, which has no types at run
 * time, takes the data as it is.
 *
 * @module
 */

/** The kind of a field: a whole number, a number, a string, a boolean, an object, an array, an array of objects, or
 * an object with the fields of another table. */
type Kind = "int" | "num" | "str" | "bool" | "obj" | "arr" | "objs" | Table;

/** Field name → kind; a name that ends in `?` may be missing. */
interface Table {
  readonly [field: string]: Kind;
}

const WORLD: Table = {
  schema: "str",
  session: "int",
  video: "str",
  g: "int",
  t: "num",
  motion: "str",
  logF: "num",
  stones: "objs",
  hands: "obj",
  events: "objs",
  stats: "obj",
  "draw?": "obj",
  "focus?": "obj",
  "rev?": "int",
};
const CARDS: Table = { schema: "str", left: "obj", right: "obj", numbers: "obj", "stage?": "obj" };
const PACKET: Table = {
  schema: "str",
  maps: "obj",
  depth: "obj",
  boxes: "obj",
  person: "obj",
  stones: "obj",
  tray: "obj",
  hands: "obj",
  both: "num",
  session: "int",
  video: "str",
  g: "int",
  i: "int",
  t: "num",
  past_valid: "bool",
  dt_past: "num",
  ms: "obj",
  "cursor?": "int",
};
const FRAME: Table = {
  cursor: "int",
  session: "int",
  video: "str",
  g: "int",
  i: "int",
  t: "num",
  past_valid: "bool",
  dt_past: "num",
  "missing?": "arr",
  "raw?": PACKET,
  "overlay?": "obj",
  "scene?": "obj",
  "cards?": CARDS,
  "world?": WORLD,
};
const SIDE: Readonly<Record<string, Table>> = {
  clock: {
    session: "int",
    revision: "int",
    video: "str",
    playing: "bool",
    rate: "num",
    anchor_media: "num",
    anchor_wall: "num",
    hold_until: "num",
    changed_by: "str",
    media_time: "num",
    server_now: "num",
    "duration?": "num",
    "focus?": "obj",
  },
  worker: {
    state: "str",
    reason: "str",
    "fps?": "num",
    "frame_ms?": "num",
    "cycle_ms?": "num",
    "gpu?": "num",
    "session?": "int",
    "g?": "int",
    "errors?": "int",
    "stage_ms?": "obj",
    "engines?": "obj",
    "model?": "str",
    "video?": "str",
  },
  gap: { gap: "int" },
  reset: { boot: "str", cursor: "int" },
};
const HEADER: Table = {
  recording: "str",
  "name?": "str",
  "video?": "str",
  "build?": "str",
  "api?": "str",
  "model?": "str",
  "backend?": "str",
  "recorded_from?": "str",
  "recorded_at?": "str",
  "notes?": "str",
  "frames?": "int",
  "g_first?": "int",
  "g_last?": "int",
  "layers?": "arr",
  "redacted?": "arr",
  "sessions?": "arr",
  "complete?": "obj",
};
/** A header's `source` (a catalog entry, `VideoEntry`): one that does not decode is left out. */
const SOURCE: Table = {
  id: "str",
  fps: "num",
  grid_step: "int",
  proxy: "str",
  proxy_wh: "arr",
  native_wh: "arr",
  "title?": "str",
  "subtitle?": "str",
  "duration?": "num",
  "frames?": "int",
  "default_start?": "num",
  "hold?": "num",
  "source_wh?": "arr",
  "crop?": "arr",
  "profile?": "str",
  "camera?": "obj",
  "held_out?": "arr",
  "stone_model?": "obj",
  "kind?": "str",
  "live?": "bool",
  "seekable?": "bool",
  "station?": "str",
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const NAMES = {
  int: "a whole number",
  num: "a number",
  str: "a string",
  bool: "a boolean",
  obj: "an object",
  arr: "an array",
  objs: "an array of objects",
} as const;

/** Null when `v` is of `kind`, else what is wrong with it. */
function misfit(v: unknown, kind: Kind): string | null {
  switch (kind) {
    case "int":
      return Number.isInteger(v) ? null : NAMES.int;
    case "num":
      return typeof v === "number" ? null : NAMES.num;
    case "str":
      return typeof v === "string" ? null : NAMES.str;
    case "bool":
      return typeof v === "boolean" ? null : NAMES.bool;
    case "obj":
      return isObject(v) ? null : NAMES.obj;
    case "arr":
      return Array.isArray(v) ? null : NAMES.arr;
    case "objs":
      return Array.isArray(v) && v.every(isObject) ? null : NAMES.objs;
    default:
      return problem(v, kind);
  }
}

/** Null when `value` is an object with the fields of `table`, each of its kind; else the first field that is not. */
function problem(value: unknown, table: Table): string | null {
  if (!isObject(value)) return "not an object";
  for (const [key, kind] of Object.entries(table)) {
    const optional = key.endsWith("?");
    const name = optional ? key.slice(0, -1) : key;
    const v = Object.prototype.hasOwnProperty.call(value, name) ? value[name] : undefined;
    if (v === undefined || v === null) {
      if (!optional) return `no ${name}`;
      continue;
    }
    const wrong = misfit(v, kind);
    if (wrong !== null) return typeof kind === "string" ? `${name} is not ${wrong}` : `${name}: ${wrong}`;
  }
  return null;
}

/** Null when a frame (an event's data or a recording line) decodes, else why it does not. */
export function frameProblem(value: unknown): string | null {
  return problem(value, FRAME);
}

/** Null when a sip1 packet (an event of `rawPackets`) decodes, else why it does not. */
export function packetProblem(value: unknown): string | null {
  return problem(value, PACKET);
}

/** Null when the data of a side event decodes (an event this SDK does not know is not checked), else why not. */
export function sideProblem(event: string, data: unknown): string | null {
  const table = Object.prototype.hasOwnProperty.call(SIDE, event) ? SIDE[event] : undefined;
  return table === undefined ? null : problem(data, table);
}

/** Null when a recording's side line decodes: `sse` a string, `recv` a number when there, `data` of its event's
 * shape; else why it does not. */
export function sideLineProblem(line: Record<string, unknown>): string | null {
  if (typeof line.sse !== "string") return "sse is not a string";
  if (line.recv !== undefined && line.recv !== null && typeof line.recv !== "number") return "recv is not a number";
  return sideProblem(line.sse, line.data);
}

/** Null when a header line decodes, else why it does not. A `source` that does not decode does not count: the
 * caller leaves it out ({@link withoutBadSource}). */
export function headerProblem(value: unknown): string | null {
  return problem(value, HEADER);
}

/** The header, without a `source` that does not decode (as Python's `RecordingHeader` leaves it out). */
export function withoutBadSource<T extends object>(header: T): T {
  const source = (header as { source?: unknown }).source;
  if (source === undefined || source === null || problem(source, SOURCE) === null) return header;
  const rest: { source?: unknown } = { ...header };
  delete rest.source;
  return rest as T;
}
