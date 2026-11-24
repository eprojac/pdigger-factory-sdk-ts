import type { CardsLayer, Frame, HandState, Rect, StoneView, WorldEvent, WorldStats } from "pdigger-factory-sdk";
import { readJson } from "./fixtures.js";

/** A stone of a synthetic world. */
export function stone(
  id: number,
  pos: [number, number, number] = [0, 0, 0.05],
  extra: Partial<StoneView> = {},
): StoneView {
  return {
    id,
    mode: "seen",
    family: "rect",
    shape: "model",
    detected: true,
    uncertain: false,
    side: null,
    outline: [
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
    ],
    solid: { pos, q: [0, 0, 0, 1], dims: [0.2, 0.14, 0.09] },
    ...extra,
  };
}

export interface FrameSpec {
  session?: number;
  video?: string;
  t?: number;
  cursor?: number;
  events?: Partial<WorldEvent>[];
  stones?: StoneView[];
  hands?: { left?: HandState; right?: HandState };
  rev?: number;
  world?: boolean;
  cards?: CardsLayer;
  board?: Rect | null;
  stats?: WorldStats;
  missing?: Frame["missing"];
}

/** A synthetic frame at grid frame `g` (t = g / 5 unless given). */
export function mkFrame(g: number, spec: FrameSpec = {}): Frame {
  const session = spec.session ?? 1;
  const video = spec.video ?? "dry1";
  const t = spec.t ?? g / 5;
  const f: Frame = {
    cursor: spec.cursor ?? g + 1,
    session,
    video,
    g,
    i: 2 * g,
    t,
    past_valid: true,
    dt_past: 0.6,
  };
  if (spec.world ?? true) {
    f.world = {
      schema: "stw1",
      session,
      video,
      g,
      t,
      motion: "static",
      logF: 0,
      stones: spec.stones ?? [],
      hands: spec.hands ?? { left: { state: "free", stone: null }, right: { state: "free", stone: null } },
      events: (spec.events ?? []) as WorldEvent[],
      stats: spec.stats ?? { stones: (spec.stones ?? []).length, confirmed: 0 },
      draw: spec.board === undefined ? undefined : { board: spec.board },
    };
    if (spec.rev !== undefined) f.world.rev = spec.rev;
  }
  if (spec.cards) f.cards = spec.cards;
  if (spec.missing) f.missing = spec.missing;
  return f;
}

export function card(title: string): CardsLayer {
  const c = { title, tone: "idle" as const, visible: true, fine: [] };
  return { schema: "crd1", left: { ...c }, right: { ...c, title: `${title} (right)` }, numbers: {} };
}

let RAW: Record<string, unknown> | null = null;

/** A sip1 packet that decodes (2.3 rule 9: the raw layer of a real frame), as JSON, with `fields` set (one set to
 * undefined is left out). */
export function sip1(fields: Record<string, unknown> = {}): string {
  RAW ??= readJson<{ raw: Record<string, unknown> }>("frames/dry1-plain-full.json").raw;
  return JSON.stringify({ ...RAW, ...fields });
}
