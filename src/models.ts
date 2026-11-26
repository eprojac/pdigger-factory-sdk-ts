/**
 * Typed models of every schema in `spec/openapi.yaml` (`components/schemas`), the wire format of the pDigger Factory
 * API v2.2.
 *
 * Field names are the wire names (snake_case where the API uses it), because these interfaces describe the JSON the
 * server sends, unchanged. Parsing is tolerant: unknown fields stay on the objects as they came, and the fields that
 * public recordings redact (face keypoints, appearance masks, depth textures, see `docs/concepts.md`) are optional.
 *
 * Integers of the spec (`g`, `cursor`, `session`, ids) are JavaScript numbers: exact up to 2^53, far above any value
 * the server sends.
 *
 * @module
 */

// ---- shared vocabulary ---------------------------------------------------------------------------------------------

/** The five layers of a grid frame. */
export type Layer = "raw" | "overlay" | "scene" | "cards" | "world";

/** Every layer, in the order the API lists them. */
export const LAYERS: readonly Layer[] = ["raw", "overlay", "scene", "cards", "world"];

/** `rounded` (default): outline .01 px, solid 1e-4, q 1e-5. `full`: unrounded, for parity runs. */
export type Precision = "rounded" | "full";

/** Wire format of a stream. */
export type StreamFormat = "sse" | "ndjson";

/** `stable`: the persistent world. `raw`: per-packet detections. */
export type RenderMode = "stable" | "raw";

/** `shapes`: semantic objects. `primitives`: flat lists with resolved styles. */
export type DrawMode = "shapes" | "primitives";

/** Form of the observed surface in a `Scene3D`. */
export type SurfaceParam = "vertices" | "compact" | "none";

/** A retained frame's map raster. */
export type RasterKind = "regions" | "mask" | "depth";

/** A hand side as the world reports it. */
export type Side = "left" | "right" | "both";

/** A 2-D point `[x, y]`. */
export type Point2 = [number, number];

/** A 3-D point `[x, y, z]`. */
export type Point3 = [number, number, number];

/** A sip1 joint `[u, v, vis, x, y, z]`, or null when not seen (or redacted). */
export type JointTuple = [number, number, number, number, number, number];

/** A sip1 stone item `[u, v, w, h, score, X, Y, Z, w_m, h_m, yaw]`. */
export type StoneTuple = [number, number, number, number, number, number, number, number, number, number, number];

/** A JSON object whose fields the spec leaves open. */
export type JsonObject = Record<string, unknown>;

// ---- errors ----------------------------------------------------------------------------------------------------------

/** Stable machine-readable error code of the API (`ErrorCode` in the spec). */
export type ApiErrorCode =
  | "invalid_json"
  | "not_an_object"
  | "chunked_refused"
  | "length_required"
  | "body_too_large"
  | "body_not_allowed"
  | "cross_origin"
  | "json_only"
  | "too_many_controls"
  | "too_many_requests"
  | "too_many_viewers"
  | "too_many_streams"
  | "unknown_video"
  | "time_out_of_range"
  | "invalid_type"
  | "missing_field"
  | "invalid_param"
  | "unknown_layer"
  | "not_retained"
  | "session_gone"
  | "stale_session"
  | "unknown_stone"
  | "world_unavailable"
  | "debug_disabled"
  | "busy"
  | "not_ready"
  | "not_found"
  | "method_not_allowed"
  | "internal"
  | "not_seekable";

/** The retained frame window of the current session. */
export interface Retained {
  session: number;
  g0?: number | null;
  g1?: number | null;
  t0?: number | null;
  t1?: number | null;
  /** 0..512 frames. */
  n: number;
}

/** The error body of every non-2xx JSON reply. */
export interface ApiError {
  /** Human-readable. */
  error: string;
  code: ApiErrorCode;
  retry_ms?: number;
  /** The parameter or body field at fault. */
  field?: string;
  retained?: Retained;
  waiting?: string[];
}

// ---- meta ------------------------------------------------------------------------------------------------------------

/** `GET /api/v2`: entry point with links, layer schema ids, limits and the build. */
export interface ApiRoot {
  api: string;
  build: string;
  /** Changes with every process start. */
  boot: string;
  backend?: "trt" | "ort" | "replay" | "none";
  spec: string;
  docs: string;
  layers: Record<string, string>;
  render: Record<string, string>;
  limits?: JsonObject;
  docs_policy?: { force_dry_run?: boolean };
}

/** One TensorRT engine of the running model. */
export interface ModelEngine {
  stage: string;
  sha256: string;
  bytes?: number;
  onnx_sha256?: string;
  int4_weights?: number;
  int4_exceptions?: number;
}

/** `GET /api/v2/model`: the model that is running. */
export interface ModelInfo {
  schema: "mdl1";
  checkpoint: string;
  name?: string;
  stage?: string;
  backend: "trt" | "ort" | "replay" | "none";
  profile?: "a" | "b" | "c" | null;
  tensorrt?: string | null;
  engines: ModelEngine[];
}

/** `GET /api/v2/topology`: skeleton topology, class names, palette and coordinate constants. */
export interface Topology {
  schema: "top1";
  /** Always 70. */
  joints: number;
  /** Joints the model never predicts. */
  never: number[];
  wrist: { left?: number; right?: number };
  tips: Record<string, number[]>;
  bones: [number, number][];
  actions: string[];
  held: string[];
  colors: Record<string, string>;
  /** `[rows, cols]` of the maps. */
  grid: [number, number];
}

// ---- sources ---------------------------------------------------------------------------------------------------------

/** Camera intrinsics and pose of a source (template gauge, not metric). */
export interface Camera {
  K?: number[][];
  R_c2w?: number[][];
  t_c2w?: number[];
  gauge?: string;
  calibrated?: boolean;
}

/**
 * A source of the shared session: a recording, or a live camera (`kind: camera`, `live: true`, `seekable: false`;
 * `duration`, `frames` and `default_start` null). An entry without `kind`, `live` or `seekable` (the recordings omit
 * them) is a seekable recording; a client fills a missing one from the others (`kind: camera` alone: live, not
 * seekable).
 */
export interface VideoEntry {
  id: string;
  title?: string;
  subtitle?: string;
  /** Null for a live camera. */
  duration: number | null;
  /** A camera: the grid it is said to run on; its frames come as they arrive. */
  fps: number;
  /** Null for a live camera. */
  frames: number | null;
  grid_step: number;
  /** Null for a live camera. */
  default_start?: number | null;
  /**
   * Seconds the playhead holds after a select or seek while the worker warms up; on a camera, the warm-up: seconds of
   * camera frames the interpreter runs on before the first is shown.
   */
  hold?: number;
  /** URL of the proxy video; empty for a live camera. */
  proxy: string;
  proxy_wh: number[];
  native_wh: number[];
  source_wh?: number[];
  crop?: number[];
  profile?: string;
  camera?: Camera;
  held_out?: number[][];
  stone_model?: JsonObject;
  /** `camera`: a live camera. Absent: a recording. */
  kind?: "recording" | "camera";
  /** True for a live camera: no duration, no seek, rate 1.0. */
  live?: boolean;
  /** Absent: true. */
  seekable?: boolean;
  /** A camera: the plant station its rig belongs to. */
  station?: string;
}

/** `GET /api/v2/videos`: the public catalog. */
export interface VideoList {
  schema: string;
  title?: string;
  /** The source a new session starts on (`aug28` on the 20.20 unit). */
  default_video?: string;
  model?: JsonObject;
  videos: VideoEntry[];
}

// ---- session ---------------------------------------------------------------------------------------------------------

/** The shared stone focus, in the shape every viewer since v1 understands. */
export interface Focus {
  n: number;
  session: number;
  video: string;
  id: number;
  g: number;
  t: number;
  x: number;
  y: number;
  z: number;
  L: number;
  W: number;
  yaw: number;
}

/**
 * Only on a live camera session. `connecting`: no camera frame yet (the worker's reason says why). `warming`: the
 * interpreter runs on the camera, nothing is released; after `warmup` seconds of frames it goes `live` and the frames
 * that follow are released, from a warm world. Any break in the stream (a pause, a camera that stopped) warms up again.
 * Each phase change bumps `revision`, so long polls and the `clock` SSE event carry it.
 */
export interface Live {
  phase: "connecting" | "warming" | "live";
  /** Seconds of camera frames interpreted before any is shown. */
  warmup: number;
  /** Epoch seconds the session started; a frame's `t` is its arrival in seconds since then. */
  since: number;
  /**
   * Seconds the shown picture is behind its arrival, interpreter included, when the session went live; play resumes at
   * `now - since - lag`.
   */
  lag: number;
}

/** The shared session state (clock, source, focus). */
export interface State {
  session: number;
  revision: number;
  video: string;
  playing: boolean;
  /**
   * Media seconds per wall second (0.3..1.0): at most 0.8 for a recording (build claude-20261122-hr4x1 lowers it
   * itself, `changed_by` `auto-rate`, when its worker falls behind: 0.75 on dry1), and always 1.0 on a live camera
   * (it sets the pace).
   */
  rate: number;
  anchor_media: number;
  /** Epoch seconds on the server's wall clock. */
  anchor_wall: number;
  /**
   * The playhead stands still until then. On a camera it stays an hour ahead while the session connects and warms up,
   * and is the moment it went live afterwards.
   */
  hold_until: number;
  /** Null on a live camera. */
  duration: number | null;
  changed_by: "start" | "viewer" | "auto-rate" | "end-of-video";
  focus: Focus | null;
  /** Seconds into the source; on a live camera, seconds since the session started (minus `live.lag` once live). */
  media_time: number;
  /** Only on a live camera session: its phase. */
  live?: Live | null;
}

/** The interpreter worker's status. */
export interface WorkerStatus {
  state: "running" | "idle" | "waiting" | "starting" | "offline" | "error" | "paused";
  reason: string;
  fps?: number;
  frame_ms?: number | null;
  cycle_ms?: number | null;
  session?: number | null;
  g?: number | null;
  gpu?: number | null;
  errors?: number;
  stage_ms?: Record<string, number>;
  engines?: Record<string, string>;
  model?: string;
  video?: string;
}

/**
 * While the shared session is paused, the world host is held on the paused grid frame and refines it on its own image
 * (fixer thin-v1). Each round that changes that frame's world releases it again with `world.rev` one higher.
 */
export interface HoldStatus {
  session: number;
  /** The held grid frame. */
  g: number;
  /** The frame refined, when it is not `g`. */
  at?: number;
  state:
    | "waiting"
    | "running"
    | "converged"
    | "nothing"
    | "limit"
    | "time"
    | "off"
    | "stale"
    | "nogray"
    | "failed"
    | "moved"
    | "released";
  /** Refine rounds run. */
  rounds: number;
  /** The newest world revision of the frame. */
  rev: number;
  /** Wall time of the rounds. */
  ms: number;
  /** Packets after the held frame stepped again from its refined world. */
  resteps: number;
}

/** The Stable sim's status. */
export interface StableStatus {
  state: "running" | "starting" | "failed" | "off" | "unusable";
  fits?: number;
  /** False: grey frames are missing, shapes come from the detections only. */
  evidence?: boolean;
  message?: string;
  /** `legacy` or `thin-v1` (thin-stone rules and the rest refinement of a paused frame). */
  fixer?: "legacy" | "thin-v1";
  hold?: HoldStatus;
}

/** `GET /api/v2/session`: the shared clock, the worker and the Stable sim. */
export interface SessionReply {
  server_now: number;
  server_recv: number;
  state: State;
  worker: WorkerStatus;
  viewers: number;
  stable: StableStatus;
}

/** Body of `POST /session/select`. For the live camera (`live`) leave `time` out. */
export interface SelectRequest {
  video: string;
  time?: number;
}

/** Body of `POST /session/seek`. */
export interface SeekRequest {
  video?: string;
  time: number;
}

/** Any JSON object, or no body at all (play, pause). Its fields are ignored. */
export type EmptyRequest = JsonObject;

/** Body of `PUT /session/focus`. */
export interface FocusRequest {
  stone_id: number;
  /** The frame the stone was picked on. */
  g?: number;
  /** Refused with 409 if not the current session. */
  session?: number;
}

/** Reply of every control. */
export interface ControlReply {
  state: State;
  server_now: number;
  server_recv: number;
  dry_run?: boolean;
}

/** The focused stone's path. */
export interface ResolvedFocus {
  id: number;
  /** Native px, oldest first, at most 512 points. */
  path2d: number[][];
  /** Scene world, oldest first, at most 512 points. */
  path3d: number[][];
}

/** `GET /session/focus`. */
export interface FocusReply {
  focus: Focus | null;
  resolved: ResolvedFocus | null;
}

// ---- raw layer (sip1) ------------------------------------------------------------------------------------------------

/**
 * One hand of a sip1 packet, as the models wrote it. The temporal model's fields (`p_action`, `action`,
 * `p_interaction`, `p_hold`, `contact`, `held`, `p_held`, `stone`) are written for both hands on every packet; when
 * `visible` is false they describe no hand, and the overlay and card layers leave them out.
 */
export interface Sip1Hand {
  visible?: boolean;
  p_action?: number[];
  action?: string;
  p_interaction?: number;
  p_hold?: number;
  contact?: number;
  held?: "empty" | "stone" | "tool" | "tray";
  p_held?: number[];
  /** Index into this packet's stones, or -1. */
  stone?: number;
  wrist?: Point2;
  p_wrist?: number;
}

/**
 * The model codec packet (`schema` = `sip1`): maps are base64 of zlib of u8 row-major; `person.joints[j]` =
 * `[u, v, vis, x, y, z]` or null (70 entries); `stones.items[k]` = `[u, v, w, h, score, X, Y, Z, w_m, h_m, yaw]`.
 */
export interface Sip1Packet {
  schema: "sip1";
  maps: {
    grid: number[];
    /** Redacted in public recordings. */
    human?: string;
    tray: string;
    stone: string;
    conf: string;
  };
  depth: {
    /** Redacted in public recordings. */
    q?: string;
    lo: number;
    hi: number;
    a: number;
    b: number;
    anchor: string;
  };
  boxes: {
    /** x0, y0, x1, y1, rot, presence */
    stone?: unknown[];
    person?: unknown[];
    /** u, v, p */
    hand_left?: number[];
    hand_right?: number[];
  };
  person: {
    present?: boolean;
    box?: number[];
    rot?: boolean;
    grid?: number[];
    /** Redacted in public recordings. */
    mask?: string;
    /** Redacted in public recordings. */
    alpha?: string;
    joints?: (JointTuple | null)[];
    scale?: number;
    bones_used?: number;
    person_scale?: number;
    scale_anchor?: "template" | "contact" | "contact-now";
  };
  /**
   * On a 4x packet (`source` `hr4`) `fg` is on `grid` [160, 256] and `tray` on `tray_grid` [80, 128], and the items
   * come from the base lattice `centre_grid` [20, 32]; a base-decode packet (recorded before the 4x stone head) has
   * `grid` [40, 64], `tray_grid` [20, 32] and none of `source`, `centres` and `centre_grid`. Read every map's size
   * from its own grid.
   */
  stones: {
    present?: boolean;
    count?: number;
    box?: number[];
    rot?: boolean;
    /** rows, cols of `fg` (160, 256 on a 4x packet; 40, 64 on a base-decode packet) */
    grid?: number[];
    fg?: string;
    /** rows, cols of `tray` (80, 128 on a 4x packet; 20, 32 on a base-decode packet) */
    tray_grid?: number[];
    tray?: string;
    items?: StoneTuple[];
    /** `hr4` on a 4x packet: the masks, tray and yaw come from the 4x stone outputs. */
    source?: "hr4";
    /** `base` on a 4x packet: the instances come from the base centre peaks. */
    centres?: "base";
    /** rows, cols of the lattice the instances are found on (20, 32; 4x packets only) */
    centre_grid?: number[];
  };
  tray: {
    valid?: boolean;
    normal?: number[];
    d?: number;
    anchor?: string;
    floor?: number;
    floor_anchor?: string;
  };
  hands: { left?: Sip1Hand; right?: Sip1Hand };
  both: number;
  session: number;
  video: string;
  g: number;
  i: number;
  t: number;
  past_valid: boolean;
  dt_past: number;
  ms: Record<string, number>;
  cursor?: number;
}

// ---- overlay, scene and cards layers ---------------------------------------------------------------------------------

/** Board rectangle in the scene world. */
export interface Rect {
  cx: number;
  cy: number;
  theta: number;
  hw: number;
  hh: number;
}

/** A wrist of the overlay layer. */
export interface Wrist {
  uv?: Point2 | null;
  visible: boolean;
  /** visible and P(interaction) >= .5 */
  filled: boolean;
  /** visible and contact >= .5 */
  ring: boolean;
  /** Index into this frame's items, or -1 (always for a hand that is not visible). */
  stone?: number;
}

/** One stone detection of the overlay layer. */
export interface OverlayItem {
  /** `[u, v, w, h, score, X, Y, Z, w_m, h_m, yaw]` */
  t: StoneTuple;
  /** Mutual-nearest index into the previous packet's items, or -1. */
  prev: number;
  side?: "left" | "right" | null;
  /** Four corners, native px. */
  outline: Point2[];
}

/** The overlay layer (`ovl1`): 2-D per packet, raw-derived. Never waits for the Stable sim. */
export interface OverlayLayer {
  schema: "ovl1";
  native_wh: [number, number];
  regions: {
    rows: number;
    cols: number;
    /** base64 u8 rows*cols. Redacted in public recordings. */
    human?: string;
    tray?: string;
    stone?: string;
  };
  mask: {
    rows: number;
    cols: number;
    /** 0 none, 1 human, 2 left, 3 right. Redacted in public recordings. */
    label?: string;
    /** Redacted in public recordings. */
    alpha?: string;
    box?: number[];
    rot?: boolean;
    present: boolean;
  };
  boxes: { person?: unknown[]; stone?: unknown[] };
  /** The sip1 joints, 70 entries `[u, v, vis, x, y, z]` or null. */
  joints: (JointTuple | null)[];
  scale?: number | null;
  wrists: { left?: Wrist; right?: Wrist };
  prev_g?: number | null;
  items: OverlayItem[];
}

/** A wrist ring in the scene world. */
export interface Ring {
  side: "left" | "right";
  pos: Point3;
}

/** One stone detection of the scene layer. */
export interface SceneItem {
  x?: number;
  y?: number;
  yaw?: number;
  L?: number;
  S?: number;
  h?: number;
  side?: "left" | "right" | null;
}

/** The scene layer (`scn1`): 3-D per packet, raw-derived. */
export interface SceneLayer {
  schema: "scn1";
  plane: { n: Point3; d: number; floor: number; anchor?: string; floor_anchor?: string };
  board: { raw?: Rect | null };
  surface: {
    rows: number;
    cols: number;
    /** base64 u8 rows*cols; logZ = a*(lo + q/255*(hi-lo)) + b. Redacted in public recordings. */
    q?: string;
    lo: number;
    hi: number;
    a: number;
    b: number;
    /** Bitset rows*cols: cells the Stable view puts on the board. */
    flat: string;
    /** Bitsets (rows-1)*(cols-1), row-major: quads kept. */
    quads: { raw: string; stable: string };
    lift: number;
  };
  /** 70 entries, scene world, raw path (face keypoints redacted in public recordings). */
  skeleton: { world: (Point3 | null)[] };
  rings?: Ring[];
  items?: SceneItem[];
}

/** One class probability of a hand card. */
export interface HandCardFine {
  key?: string;
  label?: string;
  p?: number | null;
  reliable?: boolean;
}

/**
 * A hand card of the cards layer, e.g. "Holding a stone": the temporal model's readings of one hand. For a hand that
 * is not visible they are all null (`contactOn` false, `stone` -1, every `fine[].p` null): the model's contact and
 * action guesses there describe no hand.
 */
export interface HandCard {
  title: string;
  tone: "hold" | "interact" | "idle" | "hidden" | "none";
  visible: boolean;
  pInteraction?: number | null;
  contact?: number | null;
  contactOn?: boolean;
  held?: string | null;
  pHeld?: number | null;
  action?: string | null;
  fine: HandCardFine[];
  hint?: string | null;
  stone?: number;
  pWrist?: number | null;
}

/** The cards layer (`crd1`). */
export interface CardsLayer {
  schema: "crd1";
  left: HandCard;
  right: HandCard;
  stage?: { parts?: JsonObject[]; total?: number; fps?: number } | null;
  numbers: {
    stones?: number;
    past_valid?: boolean;
    dt_past?: number;
    tray_anchor?: string;
    floor_anchor?: string;
    depth_anchor?: string;
    g?: number;
    t?: number;
    session?: number;
  };
}

// ---- world layer -----------------------------------------------------------------------------------------------------

/** A stone's solid in the scene world. */
export interface Solid {
  pos: Point3;
  /** x, y, z, w */
  q: [number, number, number, number];
  /** L, W, h */
  dims: Point3;
}

/** A stone of the world. */
export interface StoneView {
  /** Persistent over the session, the same for every viewer. */
  id: number;
  mode: "seen" | "kept" | "pushed" | "hinge" | "carry" | "placed" | "transit";
  family: "rect" | "dogbone";
  shape: "model" | "provisional" | "frozen";
  detected: boolean;
  uncertain: boolean;
  side: Side | null;
  /** Native px, 4 or 12 vertices. */
  outline: Point2[];
  solid: Solid;
  /** Packets since a put-down. */
  placed?: number;
  /** Absent or `model`: a stone the model boxed. `image`: one made from the image (fixer thin-v1). */
  source?: "model" | "image";
  /** The stone's look (the 20.20 unit sends looks since build claude-20261120-looks1), sent only in the frame it was
   * read on; see `lookScore`. */
  look?: StoneLook;
}

/**
 * A stone's look: the band-pass texture of its face, format `v` 1, for telling stones apart by appearance. The 20.20
 * unit sends looks since build claude-20261120-looks1 (fixer thin-v1, on every camera unless a catalog entry's stone
 * model turns thin.lookOut off): the recordings of 22 November (build claude-20261122-hr4x1) carry them, and those of
 * 17 November, made before it, have none. The tray rules use a look when a server sends it (SDK-DESIGN.md 4.6.2). The
 * grid holds `nu` x `nv` cells at a pitch of `sp` proxy px, centred on the face `at` and turned with it; `d` is the
 * cells as base64 of `nu` x `nv` int8 bytes, row after row, -128 for a cell not read.
 */
export interface StoneLook {
  /** Format version: only 1 is read. */
  v: number;
  /** The packet whose frame it was read on. */
  g: number;
  /** Cell pitch, proxy px. */
  sp: number;
  /** Scale of the z values: a cell is round(z q). */
  q: number;
  /** Cells along the long side (the engine sends at least 3). */
  nu: number;
  /** Cells across it (the engine sends at least 3). */
  nv: number;
  /** Proxy px per native px, x and y. */
  px: number[];
  /** The face it was read on, proxy px. */
  at: LookFace;
  /** `nu` x `nv` int8 cells, base64. */
  d: string;
}

/** The face a look was read on, in proxy px: its centre, the long side's angle (radians, x right, y down), its sides. */
export interface LookFace {
  cx: number;
  cy: number;
  theta: number;
  L: number;
  S: number;
}

/** A moment of a speckle answer: its grid frame and media time. */
export interface SpeckleMoment {
  g: number;
  t: number;
}

/**
 * One stone of one moment, as the speckle check found it at the other moment: `at` the world stone (not held) whose
 * outline holds the centre of the best place (null when none does, or when the stone was not checked); `score` the
 * zero-mean normalised cross-correlation of the best place over the ten turned templates (null: not checked: its
 * inner box is under 8 px a side or does not fit in the region);
 * `second` the best place outside the best's neighbourhood (-1: none). A find is clean when score >= 0.30 and
 * score >= 2 x second.
 */
export interface SpeckleFind {
  id: number;
  at: number | null;
  score: number | null;
  second: number | null;
}

/**
 * The unit's speckle stone identification of one tray (since build claude-20261123-speckle3; SDK-DESIGN.md 4.6.12):
 * sent once, in the world of the first frame after the unit's GPU answered. `ref` is the tray's arrival (or the first
 * later calm frame that could be kept), `at` a later calm frame of the tray; `refs` the stones at the reference checked
 * at `at`, `stones` those at `at` checked at the reference, `pairs` [id at `at`, id at the reference] of the stones
 * the unit pairs (a clean find from one lands on the other, and the other's, when clean, on the first). `tray` is the
 * unit's own count of trays.
 */
export interface WorldSpeckle {
  v: 1;
  tray: number;
  ref: SpeckleMoment;
  at: SpeckleMoment;
  /** The GPU the search ran on, as CUDA names it, with its compute capability and multiprocessors. */
  device: string;
  gpu_ms: number;
  wall_ms: number;
  stones: SpeckleFind[];
  refs: SpeckleFind[];
  pairs: [number, number][];
}

/** A hand of the world. */
export interface HandState {
  /**
   * `touch` and `grasp` are the temporal model's contact readings. With fixer thin-v1 (dry videos and cameras), a hand
   * in contact that holds no stone and whose wrist is off the board (the regions' tray map) is sent as `free`, with
   * `away` true.
   */
  state: "free" | "touch" | "grasp" | "hinge" | "carry";
  stone: number | null;
  rayK?: number;
  untrusted?: boolean;
  /**
   * Present (true) only on a hand sent as `free` because it is in contact away from the board: a worker's hand busy
   * beside the board, or a false hand on machinery. It does not hold a stone and does not work on the tray.
   */
  away?: boolean;
}

/** The wire names of world events. */
export type WorldEventType =
  "new" | "confirm" | "freeze" | "push" | "lift" | "hinge" | "carry" | "place" | "drop" | "gone" | "delete" | "split";

/** Every world event type, in the order the spec lists them. */
export const WORLD_EVENT_TYPES: readonly WorldEventType[] = [
  "new",
  "confirm",
  "freeze",
  "push",
  "lift",
  "hinge",
  "carry",
  "place",
  "drop",
  "gone",
  "delete",
  "split",
];

/** One event of a world frame. */
export interface WorldEvent {
  type: WorldEventType;
  id?: number;
  side?: string;
  why?: string;
  /** `split`: the stone's own id, which keeps the larger part, then the new part's. */
  into?: number[];
  /** `new` of a stone the model never boxed: `image` (fixer thin-v1). */
  source?: "model" | "image";
}

/** Per-packet draw terms resolved on the server. */
export interface WorldDraw {
  board?: Rect | null;
  skeleton?: { logF: number; k: Record<string, number>; elbow: Record<string, Point3> };
}

/** World statistics. */
export interface WorldStats {
  stones?: number;
  confirmed?: number;
  frozen?: number;
  fitted?: number;
  held?: number;
  stepMs?: number;
}

/**
 * The world layer (`stw1`): the Stable sim's persistent world at one grid frame. While the session is paused the world
 * of the paused frame may be released again, revised (`rev`).
 */
export interface WorldLayer {
  schema: "stw1";
  session: number;
  video: string;
  g: number;
  t: number;
  motion: "static" | "moving" | "settling";
  logF: number;
  stones: StoneView[];
  hands: { left?: HandState; right?: HandState };
  events: WorldEvent[];
  stats: WorldStats;
  draw?: WorldDraw;
  focus?: ResolvedFocus | null;
  /** Absent (0) as first released; 1, 2, ... after a refinement changed it. */
  rev?: number;
  /** The unit's speckle answer, in the world of the frame after it was ready (SDK-DESIGN.md 4.6.12). */
  speckle?: WorldSpeckle;
}

/** One grid frame with the requested layers. */
export interface Frame {
  cursor: number;
  session: number;
  video: string;
  g: number;
  i: number;
  t: number;
  past_valid: boolean;
  dt_past: number;
  /** Layers requested but not ready at the release deadline. */
  missing?: Exclude<Layer, "raw">[];
  raw?: Sip1Packet;
  overlay?: OverlayLayer;
  scene?: SceneLayer;
  cards?: CardsLayer;
  world?: WorldLayer;
}

/** `GET /session/frames`: the long-poll reply. */
export interface LiveReply {
  server_now: number;
  server_recv: number;
  state: State;
  worker: WorkerStatus;
  viewers: number;
  stable: StableStatus;
  cursor: number;
  frames: Frame[];
}

/** `GET /session/world/stones/{id}`: one stone, with its path since the session began. */
export interface StoneTrack {
  schema: "sts1";
  session: number;
  video: string;
  id: number;
  g: number;
  t: number;
  stone: StoneView | null;
  first_g: number;
  last_g: number;
  path2d: number[][];
  path3d: number[][];
}

/** One entry of the event log. */
export interface EventLogEntry {
  g: number;
  t: number;
  type: string;
  id?: number;
  side?: string;
  why?: string;
  into?: number[];
  source?: string;
}

/** `GET /session/world/events`: the event log of this session. */
export interface EventLog {
  session: number;
  video: string;
  events: EventLogEntry[];
  /** The `after` that continues this log without loss or repeats. */
  next_after: number;
  oldest_g?: number;
}

// ---- render-ready ----------------------------------------------------------------------------------------------------

/** A stone of the 2-D draw list. */
export interface DrawStone2D {
  id?: number | null;
  outline: Point2[];
  style: "held" | "placed" | "model" | "detected" | "kept" | "raw";
  side?: Side | null;
  alpha: number;
  detected?: boolean;
  uncertain?: boolean;
  shape?: string | null;
  mode?: string | null;
}

/** An image primitive (a map raster) of `Primitives2D`. */
export interface ImagePrimitive {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  alpha?: number;
  rot?: boolean;
  /** Canvas `setTransform(a, b, c, d, e, f)` from image pixels to native px. */
  transform?: [number, number, number, number, number, number];
}

/** A polygon primitive. */
export interface PolygonPrimitive {
  points: Point2[];
  stroke?: string | null;
  fill?: string | null;
  fill_alpha?: number;
  width?: number;
  dash?: number[] | null;
  alpha?: number;
}

/** A segment primitive. */
export interface SegmentPrimitive {
  from: Point2;
  to: Point2;
  color?: string;
  width?: number;
  alpha?: number;
}

/** A circle primitive. A filled wrist is a filled circle at alpha .85 and a stroked one at alpha 1. */
export interface CirclePrimitive {
  at: Point2;
  r: number;
  stroke?: string | null;
  fill?: string | null;
  width?: number;
  alpha?: number;
}

/** A label primitive. */
export interface LabelPrimitive {
  at: Point2;
  text: string;
  color?: string;
  background?: string | null;
  /** The canvas `textBaseline` that `at` is given for (top, middle). */
  baseline?: string;
}

/**
 * Flat draw lists in native px. Widths and radii are in overlay.js's line unit `lw` for a canvas of the native width;
 * scale them with the canvas.
 */
export interface Primitives2D {
  /** clamp(native width / 420, 1.2, 3). */
  lw?: number;
  images?: ImagePrimitive[];
  polygons?: PolygonPrimitive[];
  segments?: SegmentPrimitive[];
  circles?: CirclePrimitive[];
  labels?: LabelPrimitive[];
}

/** `GET /session/render/overlay2d`: the 2-D draw list, final, native px. */
export interface Overlay2D {
  schema: "r2d1";
  session: number;
  video: string;
  /** Packet a. */
  g: number;
  /** Packet b, or null. */
  bg?: number | null;
  /** Fraction from a to b. */
  f: number;
  t: number;
  mode: RenderMode;
  missing?: string[];
  native_wh: number[];
  regions?: JsonObject;
  mask?: JsonObject;
  boxes?: JsonObject[];
  stones?: DrawStone2D[];
  skeleton?: { bones?: JsonObject[]; joints?: JsonObject[] };
  wrists?: JsonObject[];
  focus?: JsonObject | null;
  primitives?: Primitives2D;
}

/** A stone of the 3-D draw list. */
export interface DrawStone3D {
  id?: number | null;
  family: "rect" | "dogbone" | "box";
  pos: number[];
  q: number[];
  dims: number[];
  side?: Side | null;
  alpha: number;
  uncertain?: boolean;
}

/** The observed surface. `vertices` is an explicit mesh; `compact` is the `scene.surface` form. */
export interface SurfaceMesh {
  form: "vertices" | "compact";
  rows: number;
  cols: number;
  /** base64 f32le x,y,z rows*cols (world). */
  positions?: string;
  /** base64 u16le triangle list. */
  indices?: string;
  opacity?: number;
  [key: string]: unknown;
}

/** 3-D primitives with resolved styles. */
export interface Primitives3D {
  boxes?: JsonObject[];
  segments?: JsonObject[];
  spheres?: JsonObject[];
  mesh?: JsonObject;
}

/** `GET /session/render/scene3d`: the 3-D scene, final, scene world. */
export interface Scene3D {
  schema: "r3d1";
  session: number;
  video: string;
  g: number;
  bg?: number | null;
  f: number;
  t: number;
  mode: RenderMode;
  missing?: string[];
  camera?: JsonObject;
  plane: JsonObject;
  board: Rect | null;
  stones: DrawStone3D[];
  skeleton: { joints?: (Point3 | null)[]; bones?: JsonObject[]; rings?: Ring[] };
  surface?: SurfaceMesh | null;
  focus?: JsonObject | null;
  primitives?: Primitives3D;
}

// ---- ops -------------------------------------------------------------------------------------------------------------

/** `GET /api/v2/health`: liveness. */
export interface Health {
  ok: boolean;
  worker: string;
  viewers: number;
}

/** `GET /api/v2/ready`: readiness. */
export interface Ready {
  ready: boolean;
  waiting: string[];
}

/** A host process of the status page. */
export interface HostStatus {
  state: "running" | "starting" | "failed" | "off";
  restarts: number;
  rss_mb?: number;
  queue?: number;
}

/** `GET /api/v2/status`: everything an operator wants on one page. */
export interface Status {
  build: string;
  boot: string;
  uptime_s: number;
  page: "legacy" | "next";
  worker: WorkerStatus;
  retained?: Retained;
  stable: StableStatus;
  hosts: Record<string, HostStatus>;
  memory?: JsonObject;
  viewers: number;
  long_polls?: number;
  streams?: number;
}

// ---- stream side events ----------------------------------------------------------------------------------------------

/** The data of an SSE `clock` event: the shared state and the server's wall clock. */
export interface ClockEvent extends State {
  server_now: number;
}

/** The data of an SSE `reset` event, for a `Last-Event-ID` of another boot; the stream goes on from the newest. */
export interface ResetEvent {
  boot: string;
  cursor: number;
}

/** The data of an SSE `gap` event (and an NDJSON line of its own): that many items were skipped. */
export interface GapEvent {
  gap: number;
}
