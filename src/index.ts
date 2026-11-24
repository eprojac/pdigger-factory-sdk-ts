/**
 * pDigger Factory SDK for TypeScript: follow the shared session of a pDigger Factory unit and read what happens on the
 * line as typed events, activities and plain sentences; replay recordings offline; stream frames; decode the model's
 * layers. Visualisation helpers are in `pdigger-factory-sdk/viz`, a fake server for tests in
 * `pdigger-factory-sdk/testing`.
 *
 * @packageDocumentation
 */
export { FactoryClient, DEFAULT_URL, type ClientOptions } from "./client.js";
export { FactoryError, isFactoryError, type ErrorCode, type SdkErrorCode, type FactoryErrorInit } from "./errors.js";
export {
  Api,
  OPERATIONS,
  layersQuery,
  parseContentRange,
  type ByteRange,
  type Catalog,
  type ContentRange,
  type ControlOptions,
  type FrameOrTime,
  type LayersParam,
  type MediaHead,
  type MediaReply,
  type Picture,
  type PollFramesParams,
  type RawStreamParams,
  type RenderOverlayParams,
  type RenderSceneParams,
  type StreamFramesParams,
} from "./api.js";
// the HTTP layer is `factory.transport`: its type is public, the class is the SDK's own
export type {
  BackoffOptions,
  FetchLike,
  Method,
  Query,
  RequestOptions,
  RequestSpec,
  StreamHandle,
  Transport,
  TransportOptions,
} from "./transport.js";
export { EventStream, MAX_LINE, SseParser, StreamEvent, parseNdjson, parseSse } from "./sse.js";
export {
  IDLE_TIMEOUT_MS,
  Streams,
  type ClockItem,
  type FrameItem,
  type FramesOptions,
  type GapItem,
  type PacketItem,
  type PollOptions,
  type RawItem,
  type RawPacketsOptions,
  type ResetItem,
  type StreamDefaults,
  type StreamItem,
  type WorkerItem,
} from "./streams.js";
export { Session, SessionClock, UNTIL_LIVE_POLL_MS, type ControlParams } from "./session.js";
export { LIVE_ID, Source } from "./sources.js";
export {
  Interpreter,
  type EventMatch,
  type InterpreterOptions,
  type InterpreterRegistry,
  type IterateOptions,
} from "./interpreter/interpreter.js";
export {
  BURST_GAP,
  InterpreterCore,
  type ClockAnchor,
  type InterpreterCoreOptions,
  type TrackPoint,
} from "./interpreter/core.js";
export {
  FactoryEvent,
  Move,
  PushBurst,
  type Activity,
  type FactoryEventInit,
  type FrameRef,
  type HandInfo,
  type InterpreterState,
  type MoveOutcome,
  type Update,
} from "./interpreter/types.js";
export {
  HAND_STATES,
  SUMMARY_EVENT_KEYS,
  Summary,
  type HandStateName,
  type SummaryEventKey,
  type SummaryJson,
  type SummaryJsonInput,
} from "./interpreter/summary.js";
export {
  CONFIDENCE,
  MOVED,
  MOVED_CONFIDENCE,
  TRAYS_KEPT,
  Tray,
  TrayCandidate,
  TrayChange,
  TrayFact,
  TrayOpen,
  TrayQuestion,
  TrayReport,
  TraySpeckle,
  TrayStone,
  StoneSpeckle,
  SPECKLE_CLEAN,
  SPECKLE_CODES,
  SPECKLE_NEAR,
  describeOpenTxt,
  describeSpeckleTxt,
  iso,
  trayReport,
  type TrayCandidateInit,
  type TrayCandidateKind,
  type TrayChangeKind,
  type TrayCounts,
  type TrayFactInit,
  type TrayFactKind,
  type TrayInit,
  type TrayOpenInit,
  type TrayPoint,
  type TrayReportInit,
  type SpeckleSide,
  type TraySpeckleInit,
  type TrayStoneEvidence,
  type TrayStoneInit,
  type TrayStoneStatus,
} from "./interpreter/trays.js";
export {
  DELETE_REASONS,
  clock,
  describeActivity,
  describeEvent,
  describeTrayFact,
  eventSentence,
  fmt,
  handWord,
  joinIds,
  round3,
  verb,
  type ActivityText,
  type EventText,
  type TrayFactText,
} from "./interpreter/text.js";
export {
  LOOK_CELLS,
  LOOK_MIN,
  LOOK_SHIFT,
  LOOK_SQUARE,
  lookPairing,
  lookPermille,
  lookScore,
  usableLook,
} from "./interpreter/looks.js";
export { Replay, type ReplayOpenOptions, type ReplayPassOptions } from "./replay.js";
export type { ReadOptions, RecordingHeader, RecordingSource } from "./recording.js";
export * as codec from "./codec.js";
export { parseMetrics, type MetricSample, type Metrics } from "./metrics.js";
export { systemClock, type Clock } from "./internal/clock.js";
export { seededRandom } from "./internal/random.js";
export { VERSION, USER_AGENT } from "./version.js";
export * from "./models.js";
