/**
 * Visualisation helpers on three.js (SDK-DESIGN.md section 11): {@link SceneView} (a `THREE.Group` of the line),
 * {@link OverlayCanvas} (the 2-D overlay on a canvas), {@link EventFeed} (the sentences in a DOM element),
 * {@link attachToClient} (drives them from a client, an Interpreter or a Replay) and {@link TrayReportView} (a tray's
 * report as a picture: the tray as it arrived and as it left, its stones coloured by the report). `three` is a peer
 * dependency.
 *
 * ```ts
 * import { FactoryClient } from "pdigger-factory-sdk";
 * import { SceneView, EventFeed, attachToClient } from "pdigger-factory-sdk/viz";
 *
 * const view = new SceneView();
 * scene.add(view.group);
 * attachToClient([view, new EventFeed(document.querySelector("#feed")!)], new FactoryClient(url));
 * ```
 *
 * @module
 */
export { SceneView, type CameraPreset, type SceneInput, type SceneViewOptions } from "./scene.js";
export { OverlayCanvas, type Context2DLike, type DrawStats, type OverlayCanvasOptions } from "./overlay.js";
export { EventFeed, type EventFeedOptions, type FeedItem } from "./feed.js";
export { attachToClient, type AttachOptions, type Attachment, type Driven, type UpdateSink } from "./attach.js";
export { DEFAULT_PALETTE, handColor, palette, skeletonColor, type Palette } from "./colors.js";
export {
  REPORT_COLORS,
  TrayReportView,
  reportMarks,
  type ReportLabel,
  type ReportMark,
  type ReportMarks,
  type ReportRole,
  type ReportSide,
  type TrayReportViewOptions,
} from "./report.js";
