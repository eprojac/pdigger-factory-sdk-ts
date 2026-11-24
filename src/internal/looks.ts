/**
 * The models' rule for a stone's look (SDK-DESIGN.md 4.6.2) and for the unit's speckle answer (4.6.12), as the other
 * languages' models have it: a look or an answer that does not fit `StoneLook` or `WorldSpeckle` by value is dropped
 * where JSON becomes a frame, a world or a stone, and its stone, world and frame stay.
 */
import { fitsLook, fitsSpeckle } from "../interpreter/looks.js";

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Drops the stone's look when it does not fit (in place); returns the stone. */
export function cleanStone<T>(stone: T): T {
  if (isObject(stone) && "look" in stone && !fitsLook(stone.look)) delete stone.look;
  return stone;
}

/** Drops the looks that do not fit from a world's stones, and a speckle answer that does not fit (in place). */
export function cleanWorld<T>(world: T): T {
  if (isObject(world) && Array.isArray(world.stones)) for (const s of world.stones) cleanStone(s);
  if (isObject(world) && "speckle" in world && !fitsSpeckle(world.speckle)) delete world.speckle;
  return world;
}

/** Drops the looks that do not fit from a frame's world (in place); returns the frame. */
export function cleanFrame<T>(frame: T): T {
  if (isObject(frame)) cleanWorld(frame.world);
  return frame;
}
