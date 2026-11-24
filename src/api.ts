/**
 * The low level (SDK-DESIGN.md section 2.2): one method per operation of `spec/openapi.yaml`, named after its
 * `operationId`, with typed parameters and replies. Every method takes `signal`, `headers` and `timeoutMs`.
 *
 * @module
 */
import { FactoryError } from "./errors.js";
import { cleanFrame, cleanStone, cleanWorld } from "./internal/looks.js";
import { parseMetrics, type Metrics } from "./metrics.js";
import type {
  ApiRoot,
  ControlReply,
  DrawMode,
  EventLog,
  FocusReply,
  Frame,
  Health,
  Layer,
  LiveReply,
  ModelInfo,
  Overlay2D,
  Precision,
  RasterKind,
  Ready,
  RenderMode,
  Scene3D,
  SeekRequest,
  SelectRequest,
  SessionReply,
  Sip1Packet,
  Status,
  StoneTrack,
  StreamFormat,
  SurfaceParam,
  Topology,
  VideoEntry,
  VideoList,
  WorldLayer,
} from "./models.js";
import { Source } from "./sources.js";
import { EventStream } from "./sse.js";
import type { Query, RequestOptions, StreamHandle, Transport } from "./transport.js";

/** Layers as a list, one layer, or the API's comma-separated string. */
export type LayersParam = Layer | readonly Layer[] | (string & Record<never, never>);

/** The query value of a layers parameter. */
export function layersQuery(layers: LayersParam | undefined): string | undefined {
  if (layers === undefined) return undefined;
  return typeof layers === "string" ? layers : layers.join(",");
}

/** Controls take `dryRun`: validate and answer without moving the shared session. */
export interface ControlOptions extends RequestOptions {
  dryRun?: boolean;
}

/** A byte range: `[start, end]` (inclusive), `[start]` (to the end), or `{ suffix: n }` (the last n bytes). */
export type ByteRange = readonly [number, number?] | { readonly suffix: number };

/** A parsed `Content-Range`. */
export interface ContentRange {
  start: number | null;
  end: number | null;
  /** Total size, null when the server does not say (`*`). */
  size: number | null;
}

/** The camera picture a live frame was interpreted from (`getFramePicture`). */
export interface Picture {
  /** The frame's grid index (the reply's `X-Interp-G`: the frame `latest` was). */
  g: number;
  /** The JPEG (640 x 360 on the plant rigs; the layers' native pixels are this picture stretched to `native_wh`). */
  jpeg: Uint8Array;
}

/** A reply of `getVideoMedia`. */
export interface MediaReply {
  /** The bytes (empty for 304). */
  bytes: Uint8Array;
  /** 200, 206, or 304 (not modified). */
  status: number;
  contentType: string | null;
  contentRange: ContentRange | null;
  etag: string | null;
  /** The whole file's size, when known. */
  size: number | null;
}

/** A reply of `headVideoMedia`. */
export interface MediaHead {
  status: number;
  contentType: string | null;
  etag: string | null;
  acceptRanges: string | null;
  /** The size: `Content-Length` of a 200, or the total of a `Content-Range`. */
  size: number | null;
}

/**
 * The catalog (`GET /api/v2/videos`) with its entries as {@link Source} models (each keeps the server's entry as
 * `entry`, and `JSON.stringify` gives the entries back), and the reply's ETag (non-enumerable, so it stays out of JSON).
 */
export type Catalog = Omit<VideoList, "videos"> & { videos: Source[]; readonly etag?: string };

/** Parameters of `streamFrames`. */
export interface StreamFramesParams extends RequestOptions {
  layers?: LayersParam;
  format?: StreamFormat;
  /** Start after this cursor. Default the newest. */
  after?: number;
  /** End the stream after this many frames (1..4096). */
  limit?: number;
  /** End the stream after this many seconds (1..3600). */
  maxS?: number;
  /** True: not counted as a viewer (`observe=1`). Default: the client's `observe`. */
  observe?: boolean;
  precision?: Precision;
  /** `<boot>-<cursor>` of the last event, to resume. */
  lastEventId?: string | null;
}

/** Parameters of `rawStream`. */
export type RawStreamParams = Omit<StreamFramesParams, "layers" | "precision">;

/** Parameters of `pollFrames`. */
export interface PollFramesParams extends RequestOptions {
  /** The last cursor this client has (default 0). */
  cursor?: number;
  /** The last state revision this client has (default 0: returns at once). */
  rev?: number;
  /** A per-tab id (8-40 of `A-Za-z0-9_-`): counts this client as a viewer. */
  cid?: string;
  layers?: LayersParam;
  /** At most this many newest frames (1..16, default 8). */
  limit?: number;
  /** Longest wait in ms (0..1000, default 1000). */
  wait?: number;
  precision?: Precision;
}

/** Exactly one of `g` and `t`. */
export type FrameOrTime = { g: number; t?: never } | { t: number; g?: never };

/** Parameters of `renderOverlay2d`. */
export type RenderOverlayParams = FrameOrTime &
  RequestOptions & {
    mode?: RenderMode;
    draw?: DrawMode;
    /** Answer 410 if this is not the current session. */
    session?: number;
  };

/** Parameters of `renderScene3d`. */
export type RenderSceneParams = RenderOverlayParams & { surface?: SurfaceParam };

function dry(dryRun: boolean | undefined): number | undefined {
  return dryRun ? 1 : undefined;
}

function req(options: RequestOptions | undefined): RequestOptions {
  return {
    signal: options?.signal,
    headers: options?.headers,
    timeoutMs: options?.timeoutMs,
    retries: options?.retries,
  };
}

/** Parses `Content-Range`: `bytes a-b/size`, or a star for an unknown range or size. */
export function parseContentRange(value: string | null): ContentRange | null {
  if (value === null) return null;
  const m = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/i.exec(value.trim());
  if (!m) return null;
  return {
    start: m[1] === undefined ? null : Number(m[1]),
    end: m[2] === undefined ? null : Number(m[2]),
    size: m[3] === "*" ? null : Number(m[3]),
  };
}

function rangeHeader(range: ByteRange): string {
  if ("suffix" in range) return `bytes=-${range.suffix}`;
  const [start, end] = range;
  return end === undefined ? `bytes=${start}-` : `bytes=${start}-${end}`;
}

/** Media that would never end (a live stream), refused by `getVideoMedia`. */
function endlessMedia(id: string, status: number | null): FactoryError {
  return new FactoryError({
    code: "not_seekable",
    field: "id",
    status,
    message: `the media of ${id} is a live stream that never ends: read it with openVideoMedia()`,
  });
}

function frameOrTime(params: FrameOrTime): Query {
  const hasG = params.g !== undefined;
  const hasT = params.t !== undefined;
  if (hasG === hasT) {
    throw new FactoryError({ code: "invalid_param", field: "t", message: "give exactly one of g and t" });
  }
  return hasG ? { g: params.g } : { t: params.t };
}

/** One method per HTTP operation. Reach it as `factory.api`. */
export class Api {
  constructor(
    private readonly http: Transport,
    private readonly defaults: { observe: boolean } = { observe: false },
  ) {}

  // ---- Interpreter -----------------------------------------------------------------------------------------------

  /** `GET /api/v2/session/world`: the world of the newest retained frame that has one, at its newest revision. */
  getWorld(params: { precision?: Precision } & RequestOptions = {}): Promise<WorldLayer> {
    return this.http
      .object<WorldLayer>({
        method: "GET",
        path: "/api/v2/session/world",
        query: { precision: params.precision },
        ...req(params),
      })
      .then(cleanWorld);
  }

  /** `GET /api/v2/session/world/events`: the event log of this session, oldest first. */
  getWorldEvents(
    params: { after?: number; limit?: number; type?: string | readonly string[] } & RequestOptions = {},
  ): Promise<EventLog> {
    const type = typeof params.type === "string" || params.type === undefined ? params.type : params.type.join(",");
    return this.http.object({
      method: "GET",
      path: "/api/v2/session/world/events",
      query: { after: params.after, limit: params.limit, type },
      ...req(params),
    });
  }

  /** `GET /api/v2/session/world/stones/{id}`: one stone, with its path since the session began. */
  getStone(id: number, options?: RequestOptions): Promise<StoneTrack> {
    return this.http
      .object<StoneTrack>({ method: "GET", path: `/api/v2/session/world/stones/${id}`, ...req(options) })
      .then((track) => {
        cleanStone(track.stone);
        return track;
      });
  }

  /** `GET /api/v2/session/focus`: the stone highlighted for every viewer, and its path. */
  getFocus(options?: RequestOptions): Promise<FocusReply> {
    return this.http.object({ method: "GET", path: "/api/v2/session/focus", ...req(options) });
  }

  /**
   * `PUT /api/v2/session/focus`: highlights a stone for every viewer. Mutates the shared session for everyone (unless
   * `dryRun`).
   */
  putFocus(stoneId: number, params: { g?: number; session?: number } & ControlOptions = {}): Promise<ControlReply> {
    const body: Record<string, number> = { stone_id: stoneId };
    if (params.g !== undefined) body.g = params.g;
    if (params.session !== undefined) body.session = params.session;
    return this.http.object({
      method: "PUT",
      path: "/api/v2/session/focus",
      query: { dry_run: dry(params.dryRun) },
      body,
      ...req(params),
    });
  }

  /** `DELETE /api/v2/session/focus`: clears the highlight for every viewer (unless `dryRun`). */
  deleteFocus(params: ControlOptions = {}): Promise<ControlReply> {
    return this.http.object({
      method: "DELETE",
      path: "/api/v2/session/focus",
      query: { dry_run: dry(params.dryRun) },
      ...req(params),
    });
  }

  // ---- Sources -----------------------------------------------------------------------------------------------------

  /**
   * `GET /api/v2/videos`: the public catalog, its entries as {@link Source} models (the shipping fields `kind`, `live`
   * and `seekable` defaulted for today's server). With `ifNoneMatch`, null means unchanged (304).
   */
  listVideos(params?: RequestOptions): Promise<Catalog>;
  listVideos(params: { ifNoneMatch: string } & RequestOptions): Promise<Catalog | null>;
  async listVideos(params: { ifNoneMatch?: string } & RequestOptions = {}): Promise<Catalog | null> {
    const headers: Record<string, string> = { ...(params.headers ?? {}) };
    if (params.ifNoneMatch !== undefined) headers["If-None-Match"] = params.ifNoneMatch;
    return this.http.request(
      { method: "GET", path: "/api/v2/videos", ...req(params), headers, okStatus: [304] },
      async (res) => {
        if (res.status === 304) return null;
        const text = await res.text();
        let list: unknown;
        try {
          list = JSON.parse(text);
        } catch (cause) {
          throw new FactoryError({ code: "decode", status: res.status, message: "the catalog is not JSON", cause });
        }
        if (typeof list !== "object" || list === null || !Array.isArray((list as VideoList).videos)) {
          throw new FactoryError({ code: "decode", status: res.status, message: "the catalog has no videos list" });
        }
        const raw = list as VideoList;
        const catalog: Catalog = { ...raw, videos: raw.videos.map((v) => new Source(v)) };
        const etag = res.headers.get("etag");
        if (etag !== null) Object.defineProperty(catalog, "etag", { value: etag, enumerable: false });
        return catalog;
      },
    );
  }

  /** `GET /api/v2/videos/{id}`: one catalog entry, as a {@link Source} (the server's entry is its `entry`). */
  async getVideo(id: string, options?: RequestOptions): Promise<Source> {
    const entry = await this.http.object<VideoEntry>({
      method: "GET",
      path: `/api/v2/videos/${encodeURIComponent(id)}`,
      ...req(options),
    });
    return new Source(entry);
  }

  /**
   * `GET /api/v2/videos/{id}/media`: the proxy video, or one byte range of it, read into memory. A file is read whole,
   * so for a large one ask for ranges.
   *
   * A live camera has no media (`404 not_found`): its pictures come with its frames ({@link Api.getFramePicture}). A
   * reply with neither a length nor byte ranges would never end: it rejects with `not_seekable` (field `id`), closing
   * the connection; read such media with {@link Api.openVideoMedia}. A range past the end rejects with `invalid_param`
   * (field `range`, status 416); its `headers` keep the `Content-Range` with the size.
   */
  getVideoMedia(
    id: string,
    params: { range?: ByteRange; ifRange?: string; ifNoneMatch?: string } & RequestOptions = {},
  ): Promise<MediaReply> {
    const headers: Record<string, string> = { ...(params.headers ?? {}) };
    if (params.range !== undefined) headers.Range = rangeHeader(params.range);
    if (params.ifRange !== undefined) headers["If-Range"] = params.ifRange;
    if (params.ifNoneMatch !== undefined) headers["If-None-Match"] = params.ifNoneMatch;
    const spec = {
      method: "GET",
      path: `/api/v2/videos/${encodeURIComponent(id)}/media`,
      accept: "video/mp4",
      ...req(params),
      headers,
      okStatus: [304, 416],
    } as const;
    return this.http.request(spec, async (res) => {
      const contentRange = parseContentRange(res.headers.get("content-range"));
      const length = res.headers.get("content-length");
      if (res.status === 416) {
        await res.body?.cancel().catch(() => undefined);
        const size = contentRange?.size ?? null;
        throw new FactoryError({
          code: "invalid_param",
          field: "range",
          status: 416,
          message: `range not satisfiable for ${id}${size === null ? "" : `: it has ${size} bytes`}`,
          headers: res.headers,
        });
      }
      if (res.status === 200 && length === null && res.headers.get("accept-ranges") !== "bytes") {
        await res.body?.cancel().catch(() => undefined); // closes the connection of an endless body
        throw endlessMedia(id, res.status);
      }
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        status: res.status,
        contentType: res.headers.get("content-type"),
        contentRange,
        etag: res.headers.get("etag"),
        size: contentRange?.size ?? (res.status === 200 && length !== null ? Number(length) : null),
      };
    });
  }

  /** `HEAD /api/v2/videos/{id}/media`: the same headers with no body. */
  headVideoMedia(id: string, options?: RequestOptions): Promise<MediaHead> {
    return this.http.request(
      { method: "HEAD", path: `/api/v2/videos/${encodeURIComponent(id)}/media`, accept: "video/mp4", ...req(options) },
      (res) => {
        const contentRange = parseContentRange(res.headers.get("content-range"));
        const length = res.headers.get("content-length");
        return Promise.resolve({
          status: res.status,
          contentType: res.headers.get("content-type"),
          etag: res.headers.get("etag"),
          acceptRanges: res.headers.get("accept-ranges"),
          size: contentRange?.size ?? (length !== null ? Number(length) : null),
        });
      },
    );
  }

  /** `GET /api/v2/videos/{id}/media` as a byte stream (a large file, or media without an end). `close()` when done. */
  openVideoMedia(id: string, options?: RequestOptions): Promise<StreamHandle> {
    return this.http.stream({
      method: "GET",
      path: `/api/v2/videos/${encodeURIComponent(id)}/media`,
      accept: "video/mp4",
      ...req(options),
    });
  }

  // ---- Session -----------------------------------------------------------------------------------------------------

  /** `GET /api/v2/session`: the shared clock, the worker and the Stable sim. */
  getSession(options?: RequestOptions): Promise<SessionReply> {
    return this.http.object({ method: "GET", path: "/api/v2/session", ...req(options) });
  }

  /** `POST /api/v2/session/select`: switches the shared session to another video, for every viewer (unless `dryRun`). */
  sessionSelect(body: SelectRequest, params: ControlOptions = {}): Promise<ControlReply> {
    return this.http.object({
      method: "POST",
      path: "/api/v2/session/select",
      query: { dry_run: dry(params.dryRun) },
      body,
      ...req(params),
    });
  }

  /** `POST /api/v2/session/seek`: moves the shared playhead and starts a new run for every viewer (unless `dryRun`). */
  sessionSeek(body: SeekRequest, params: ControlOptions = {}): Promise<ControlReply> {
    return this.http.object({
      method: "POST",
      path: "/api/v2/session/seek",
      query: { dry_run: dry(params.dryRun) },
      body,
      ...req(params),
    });
  }

  /** `POST /api/v2/session/play`: resumes the shared playhead for every viewer (unless `dryRun`). Idempotent. */
  sessionPlay(params: ControlOptions = {}): Promise<ControlReply> {
    return this.http.object({
      method: "POST",
      path: "/api/v2/session/play",
      query: { dry_run: dry(params.dryRun) },
      body: {},
      ...req(params),
    });
  }

  /** `POST /api/v2/session/pause`: pauses the shared playhead for every viewer (unless `dryRun`). Idempotent. */
  sessionPause(params: ControlOptions = {}): Promise<ControlReply> {
    return this.http.object({
      method: "POST",
      path: "/api/v2/session/pause",
      query: { dry_run: dry(params.dryRun) },
      body: {},
      ...req(params),
    });
  }

  // ---- Streams -----------------------------------------------------------------------------------------------------

  /**
   * `GET /api/v2/session/frames/stream`: one connection of the frame stream (SSE by default), as raw events. The mid
   * level (`factory.streams.frames()`) adds resume, backfill and revisions on top.
   */
  async streamFrames(params: StreamFramesParams = {}): Promise<EventStream> {
    const format = params.format ?? "sse";
    const handle = await this.http.stream({
      method: "GET",
      path: "/api/v2/session/frames/stream",
      query: {
        layers: layersQuery(params.layers),
        format,
        after: params.after,
        limit: params.limit,
        max_s: params.maxS,
        observe: (params.observe ?? this.defaults.observe) ? 1 : undefined,
        precision: params.precision,
      },
      accept: format === "sse" ? "text/event-stream" : "application/x-ndjson",
      ...req(params),
      headers: lastEventHeaders(params),
    });
    return new EventStream(handle, params.lastEventId ?? null);
  }

  /** `GET /api/v2/session/frames`: one long-poll for new frames. */
  pollFrames(params: PollFramesParams = {}): Promise<LiveReply> {
    return this.http
      .object<LiveReply>({
        method: "GET",
        path: "/api/v2/session/frames",
        query: {
          cursor: params.cursor,
          rev: params.rev,
          cid: params.cid,
          layers: layersQuery(params.layers),
          limit: params.limit,
          wait: params.wait,
          precision: params.precision,
        },
        ...req(params),
        timeoutMs: params.timeoutMs ?? Math.max(this.http.timeoutMs, (params.wait ?? 1000) + 5000),
      })
      .then((reply) => {
        for (const f of Array.isArray(reply.frames) ? reply.frames : []) cleanFrame(f);
        return reply;
      });
  }

  /** `GET /api/v2/raw/stream`: one connection of the raw `sip1` packet stream (SSE by default), as raw events. */
  async rawStream(params: RawStreamParams = {}): Promise<EventStream> {
    const format = params.format ?? "sse";
    const handle = await this.http.stream({
      method: "GET",
      path: "/api/v2/raw/stream",
      query: {
        format,
        after: params.after,
        limit: params.limit,
        max_s: params.maxS,
        observe: (params.observe ?? this.defaults.observe) ? 1 : undefined,
      },
      accept: format === "sse" ? "text/event-stream" : "application/x-ndjson",
      ...req(params),
      headers: lastEventHeaders(params),
    });
    return new EventStream(handle, params.lastEventId ?? null);
  }

  // ---- Render-ready ------------------------------------------------------------------------------------------------

  /** `GET /api/v2/session/render/overlay2d`: everything the 2-D overlay draws, final, native px. */
  renderOverlay2d(params: RenderOverlayParams): Promise<Overlay2D> {
    return this.http.object({
      method: "GET",
      path: "/api/v2/session/render/overlay2d",
      query: { ...frameOrTime(params), mode: params.mode, draw: params.draw, session: params.session },
      ...req(params),
    });
  }

  /** `GET /api/v2/session/render/scene3d`: everything the 3-D view draws, final, scene world. */
  renderScene3d(params: RenderSceneParams): Promise<Scene3D> {
    return this.http.object({
      method: "GET",
      path: "/api/v2/session/render/scene3d",
      query: {
        ...frameOrTime(params),
        mode: params.mode,
        draw: params.draw,
        surface: params.surface,
        session: params.session,
      },
      ...req(params),
    });
  }

  // ---- Frames and codec --------------------------------------------------------------------------------------------

  /** `GET /api/v2/session/frames/{g}`: a retained frame (`g` or `"latest"`). */
  getFrame(
    g: number | "latest",
    params: { layers?: LayersParam; session?: number; precision?: Precision } & RequestOptions = {},
  ): Promise<Frame> {
    return this.http
      .object<Frame>({
        method: "GET",
        path: `/api/v2/session/frames/${g}`,
        query: { layers: layersQuery(params.layers), session: params.session, precision: params.precision },
        ...req(params),
      })
      .then(cleanFrame);
  }

  /**
   * `GET /api/v2/session/frames/{g}/image.jpg`: the camera picture live frame `g` (or `"latest"`) was interpreted from.
   * The newest 64 of a camera session are kept: an older frame, or a warm-up frame (never released), is `404
   * not_retained`; with `session`, a frame of an ended session is `410 session_gone`. A recording has none (`404
   * not_found`): its picture is the proxy video.
   */
  async getFramePicture(g: number | "latest", params: { session?: number } & RequestOptions = {}): Promise<Picture> {
    const { bytes, response } = await this.http.bytes({
      method: "GET",
      path: `/api/v2/session/frames/${g}/image.jpg`,
      query: { session: params.session },
      accept: "image/jpeg",
      ...req(params),
    });
    const shown = response.headers.get("x-interp-g") ?? "";
    if (!/^\d+$/.test(shown)) {
      throw new FactoryError({
        code: "decode",
        status: response.status,
        message: "the picture reply has no X-Interp-G header",
      });
    }
    return { g: Number(shown), jpeg: bytes };
  }

  /** `GET /api/v2/session/frames/{g}/{raster}.png`: a retained frame's map as PNG bytes (64 x 40 times `scale`). */
  async getFrameRaster(
    g: number,
    raster: RasterKind,
    params: { scale?: number } & RequestOptions = {},
  ): Promise<Uint8Array> {
    const { bytes } = await this.http.bytes({
      method: "GET",
      path: `/api/v2/session/frames/${g}/${raster}.png`,
      query: { scale: params.scale },
      accept: "image/png",
      ...req(params),
    });
    return bytes;
  }

  /** `GET /api/v2/raw/packets/{g}`: one raw packet of the retained window (`g` or `"latest"`). */
  rawPacket(g: number | "latest", params: { session?: number } & RequestOptions = {}): Promise<Sip1Packet> {
    return this.http.object({
      method: "GET",
      path: `/api/v2/raw/packets/${g}`,
      query: { session: params.session },
      ...req(params),
    });
  }

  /** `GET /api/v2/raw/tensors/{g}`: the debug tensors as `.npz` bytes (`debug_disabled` when off). */
  async rawTensors(g: number, options?: RequestOptions): Promise<Uint8Array> {
    const { bytes } = await this.http.bytes({
      method: "GET",
      path: `/api/v2/raw/tensors/${g}`,
      accept: "application/octet-stream",
      ...req(options),
    });
    return bytes;
  }

  // ---- Meta and ops ------------------------------------------------------------------------------------------------

  /** `GET /api/v2`: entry point with links, layer schema ids, limits and the build. */
  getApiRoot(options?: RequestOptions): Promise<ApiRoot> {
    return this.http.object({ method: "GET", path: "/api/v2", ...req(options) });
  }

  /** `GET /api/v2/openapi.yaml`: the specification, as YAML text. */
  getOpenApi(options?: RequestOptions): Promise<string> {
    return this.http.text({ method: "GET", path: "/api/v2/openapi.yaml", accept: "application/yaml", ...req(options) });
  }

  /** `GET /api/v2/model`: the model that is running. */
  getModel(options?: RequestOptions): Promise<ModelInfo> {
    return this.http.object({ method: "GET", path: "/api/v2/model", ...req(options) });
  }

  /** `GET /api/v2/topology`: skeleton topology, class names, palette and coordinate constants. */
  getTopology(options?: RequestOptions): Promise<Topology> {
    return this.http.object({ method: "GET", path: "/api/v2/topology", ...req(options) });
  }

  /** `GET /api/v2/health`: liveness. */
  getHealth(options?: RequestOptions): Promise<Health> {
    return this.http.object({ method: "GET", path: "/api/v2/health", ...req(options) });
  }

  /** `GET /api/v2/ready`: readiness (a `not_ready` error, with `waiting`, until the unit is up). */
  getReady(options?: RequestOptions): Promise<Ready> {
    return this.http.object({ method: "GET", path: "/api/v2/ready", ...req(options) });
  }

  /** `GET /api/v2/status`: everything an operator wants on one page. */
  getStatus(options?: RequestOptions): Promise<Status> {
    return this.http.object({ method: "GET", path: "/api/v2/status", ...req(options) });
  }

  /** `GET /metrics`: the Prometheus text and its samples `{name, labels, value}`. */
  async getMetrics(options?: RequestOptions): Promise<Metrics> {
    const text = await this.http.text({ method: "GET", path: "/metrics", accept: "text/plain", ...req(options) });
    return { text, samples: parseMetrics(text) };
  }
}

function lastEventHeaders(params: StreamFramesParams | RawStreamParams): Record<string, string> {
  const h: Record<string, string> = { ...(params.headers ?? {}) };
  if (params.lastEventId) h["Last-Event-ID"] = params.lastEventId;
  return h;
}

/** The operationIds this class covers (32). */
export const OPERATIONS = [
  "getWorld",
  "getWorldEvents",
  "getStone",
  "getFocus",
  "putFocus",
  "deleteFocus",
  "listVideos",
  "getVideo",
  "getVideoMedia",
  "getSession",
  "sessionSelect",
  "sessionSeek",
  "sessionPlay",
  "sessionPause",
  "streamFrames",
  "pollFrames",
  "rawStream",
  "renderOverlay2d",
  "renderScene3d",
  "getFrame",
  "getFramePicture",
  "getFrameRaster",
  "rawPacket",
  "rawTensors",
  "getApiRoot",
  "getOpenApi",
  "getModel",
  "getTopology",
  "getHealth",
  "getReady",
  "getStatus",
  "getMetrics",
] as const;
