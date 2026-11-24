/**
 * Colours of the visualisation helpers: the palette of `GET /api/v2/topology` (the same colours the unit's own viewer
 * uses), plus the hand colours for `both` and no hand.
 *
 * @module
 */
import type { Topology } from "../models.js";

/** The palette keys every view reads. */
export interface Palette {
  focus: string;
  human: string;
  left: string;
  right: string;
  both: string;
  none: string;
  personBox: string;
  skelBody: string;
  skelLeft: string;
  skelRight: string;
  stoneBox: string;
  stones: string;
  kept: string;
  tray: string;
  board: string;
  surface: string;
}

/** The palette of the 20.20 unit (build int17), with `both`, `none`, `kept`, `board` and `surface` added. */
export const DEFAULT_PALETTE: Readonly<Palette> = {
  focus: "#ff4fc8",
  human: "#00e15a",
  left: "#f68c36",
  right: "#00b5ff",
  both: "#c38bff",
  none: "#9aa4ad",
  personBox: "#ed50e9",
  skelBody: "#a4f1be",
  skelLeft: "#ff9a39",
  skelRight: "#51bcff",
  stoneBox: "#a4b0ba",
  stones: "#ffd60a",
  kept: "#c9b46a",
  tray: "#00dcff",
  board: "#2b3a4a",
  surface: "#7f93a8",
};

/** A palette: the defaults, then a topology's colours, then explicit overrides. */
export function palette(topology?: Pick<Topology, "colors"> | null, overrides: Partial<Palette> = {}): Palette {
  const fromTopology: Partial<Palette> = {};
  for (const [k, v] of Object.entries(topology?.colors ?? {})) {
    if (k in DEFAULT_PALETTE) (fromTopology as Record<string, string>)[k] = v;
  }
  return { ...DEFAULT_PALETTE, ...fromTopology, ...overrides };
}

/** The colour of a hand: `left`, `right`, `both`, or `none` for no hand. */
export function handColor(side: string | null | undefined, colors: Palette = DEFAULT_PALETTE): string {
  if (side === "left") return colors.left;
  if (side === "right") return colors.right;
  if (side === "both") return colors.both;
  return colors.none;
}

/** The skeleton colour of a bone or joint side (`body`, `left`, `right`). */
export function skeletonColor(side: string | null | undefined, colors: Palette = DEFAULT_PALETTE): string {
  if (side === "left") return colors.skelLeft;
  if (side === "right") return colors.skelRight;
  return colors.skelBody;
}
