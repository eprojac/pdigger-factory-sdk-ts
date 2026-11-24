/**
 * `attachToClient` (SDK-DESIGN.md section 11): drives views from a client (its Interpreter), an Interpreter, or a
 * Replay: every update goes to every view, until the stream ends or `stop()` is called.
 *
 * @module
 */
import type { FactoryClient } from "../client.js";
import { isAbortError } from "../internal/abort.js";
import type { Clock } from "../internal/clock.js";
import { Interpreter, type InterpreterOptions } from "../interpreter/interpreter.js";
import type { Update } from "../interpreter/types.js";
import type { Layer, WorldLayer } from "../models.js";
import { Replay } from "../replay.js";
import { EventFeed } from "./feed.js";
import { OverlayCanvas } from "./overlay.js";
import { SceneView } from "./scene.js";

/** Anything with an `update(update)` method can be driven too. */
export interface UpdateSink {
  update(update: Update): void;
}

/** What `attachToClient` drives. */
export type Driven = SceneView | OverlayCanvas | EventFeed | UpdateSink;

/**
 * The layers the Interpreter made for a client streams unless `interpreter.layers` names others: what the views draw
 * (the world and cards for the stones and the feed; the scene and overlay layers for the skeleton, wrist rings and
 * boxes, and the overlay's native video size).
 */
const VIEW_LAYERS: readonly Layer[] = ["world", "cards", "scene", "overlay"];

/** Options of {@link attachToClient}. */
export interface AttachOptions {
  /** Options of the Interpreter made for a client (its layers default to world, cards, scene and overlay). */
  interpreter?: InterpreterOptions;
  /** Replay pacing (default `realtime`: frames at their media times). */
  pace?: "none" | "realtime";
  /** Replay speed factor (default 1). */
  speed?: number;
  /** Clock of the replay pacing. */
  clock?: Clock;
  /** Called after the views took an update. */
  onUpdate?: (update: Update) => void;
  signal?: AbortSignal;
}

/** A running attachment. */
export interface Attachment {
  /** Settles when the updates end (resolves), `stop()` is called (resolves) or the stream fails (rejects). */
  readonly done: Promise<void>;
  /** Updates delivered so far. */
  readonly count: number;
  /** Stops following and closes the stream. */
  stop(): void;
}

/**
 * Gives `update` to `view`. `lastWorld` is the attachment's newest world per overlay canvas: a frame whose world is late
 * (or not asked for) draws over it while it is of the frame's session and video, so another session, another video or
 * another attachment of the canvas never shows stones that are not theirs.
 */
function deliver(view: Driven, update: Update, lastWorld: Map<OverlayCanvas, WorldLayer>): void {
  if (view instanceof EventFeed) view.addUpdate(update);
  else if (view instanceof SceneView) {
    if (update.frame !== null) view.update(update.frame);
  } else if (view instanceof OverlayCanvas) {
    const f = update.frame;
    if (f === null || (f.world === undefined && f.overlay === undefined)) return; // nothing it draws
    if (f.world !== undefined) lastWorld.set(view, f.world);
    const kept = lastWorld.get(view);
    const world = f.world ?? (kept?.session === f.session && kept.video === f.video ? kept : undefined);
    view.draw(world === undefined ? f : { ...f, world });
  } else view.update(update);
}

/**
 * Drives `views` from a client (an Interpreter of its own, streaming the layers the views draw, closed when the
 * attachment ends), an Interpreter (left open: it is yours) or a Replay.
 */
export function attachToClient(
  views: Driven | readonly Driven[],
  source: FactoryClient | Interpreter | Replay,
  options: AttachOptions = {},
): Attachment {
  const list: readonly Driven[] = Array.isArray(views) ? views : [views as Driven];
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  let count = 0;
  const signal = controller.signal;
  let updates: AsyncIterable<Update>;
  /** The Interpreter made here for a client: closed when the attachment ends. */
  let own: Interpreter | null = null;
  if (source instanceof Replay) {
    updates = source.updates({ pace: options.pace ?? "realtime", speed: options.speed, clock: options.clock, signal });
  } else if (source instanceof Interpreter) updates = source.updates({ signal });
  else {
    own = source.interpreter({ ...options.interpreter, layers: options.interpreter?.layers ?? VIEW_LAYERS });
    updates = own.updates({ signal });
  }
  const lastWorld = new Map<OverlayCanvas, WorldLayer>();
  const done = (async () => {
    try {
      for await (const u of updates) {
        for (const v of list) deliver(v, u, lastWorld);
        count++;
        options.onUpdate?.(u);
      }
    } catch (err) {
      if (!(signal.aborted && isAbortError(err))) throw err;
    } finally {
      own?.close();
      options.signal?.removeEventListener("abort", onAbort);
    }
  })();
  return {
    done,
    get count() {
      return count;
    },
    stop: () => controller.abort(new DOMException("stopped", "AbortError")),
  };
}
