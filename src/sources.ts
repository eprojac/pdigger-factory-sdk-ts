/**
 * Sources of the shared session (SDK-DESIGN.md section 3): the recordings and the live cameras.
 *
 * @module
 */
import type { Camera, VideoEntry } from "./models.js";

/**
 * The id the SDK's design gave the one live camera before cameras shipped. A unit lists its cameras by their serials
 * (`FactoryClient.cameras()`, {@link Source.isLive}); the SDK still treats this id as a camera.
 */
export const LIVE_ID = "live";

/**
 * A source of the shared session: a recording or a live camera. An entry without `kind`, `live` or `seekable` (the
 * unit's recordings omit them) is a seekable recording; a missing one is filled from the others (`kind: "camera"`
 * alone: live, not seekable).
 */
export class Source {
  readonly id: string;
  readonly title: string | null;
  readonly subtitle: string | null;
  /** `recording`, or `camera` for a live camera. */
  readonly kind: "recording" | "camera";
  /** True for a live camera: no duration, no seek, rate 1.0. */
  readonly live: boolean;
  readonly seekable: boolean;
  /** Seconds; null for a live camera. */
  readonly duration: number | null;
  /** Source frames; null for a live camera. */
  readonly frames: number | null;
  readonly fps: number;
  /** Source frames per grid frame. */
  readonly gridStep: number;
  /** Where a select starts by default; null for a live camera. */
  readonly defaultStart: number | null;
  /**
   * Seconds the playhead holds after a select while the worker warms up; on a camera, the warm-up (3 on the plant
   * cameras). Null when the server does not say.
   */
  readonly hold: number | null;
  /** A camera: the plant station its rig belongs to; null otherwise. */
  readonly station: string | null;
  /** Native px of the model crop `[W, H]`. */
  readonly nativeWh: readonly number[];
  readonly proxy: string;
  readonly camera: Camera | null;
  /** Held-out intervals `[t0, t1]` (empty for a live camera). */
  readonly heldOut: readonly (readonly number[])[];
  /** The catalog entry as the server sent it. */
  readonly entry: VideoEntry;

  constructor(entry: VideoEntry) {
    this.entry = entry;
    this.id = entry.id;
    this.title = entry.title ?? null;
    this.subtitle = entry.subtitle ?? null;
    this.live = entry.live ?? entry.kind === "camera";
    this.kind = entry.kind ?? (this.live ? "camera" : "recording");
    this.seekable = entry.seekable ?? !this.live;
    this.duration = this.live ? null : (entry.duration ?? null);
    this.frames = this.live ? null : (entry.frames ?? null);
    this.fps = entry.fps;
    this.gridStep = entry.grid_step;
    this.defaultStart = this.live ? null : (entry.default_start ?? null);
    this.hold = entry.hold ?? null;
    this.station = entry.station ?? null;
    this.nativeWh = entry.native_wh;
    this.proxy = entry.proxy;
    this.camera = entry.camera ?? null;
    this.heldOut = entry.held_out ?? [];
  }

  /** True for a live camera. */
  get isLive(): boolean {
    return this.live;
  }

  /** Fraction of the source played at media time `t` (0..1), or null for a live camera or without a duration. */
  progress(t: number): number | null {
    if (this.live || this.duration === null || this.duration <= 0) return null;
    return Math.min(1, Math.max(0, t / this.duration));
  }

  toJSON(): VideoEntry {
    return this.entry;
  }
}
