/** Constants of the fake server: the real 20.20 topology and a tiny PNG. */
export { TOPOLOGY } from "../topology.js";

/** A 1 x 1 transparent PNG, for rasters the fake has no recorded reply for. */
export const TINY_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
  0, 0, 0, 11, 73, 68, 65, 84, 120, 156, 99, 96, 0, 2, 0, 0, 5, 0, 1, 122, 94, 171, 63, 0, 0, 0, 0, 73, 69, 78, 68, 174,
  66, 96, 130,
]);
