/** The three.js helpers, for a browser project (see core.ts). */
import { FactoryClient, type Frame, type Tray } from "pdigger-factory-sdk";
import {
  EventFeed,
  OverlayCanvas,
  REPORT_COLORS,
  SceneView,
  TrayReportView,
  attachToClient,
  reportMarks,
  type ReportLabel,
} from "pdigger-factory-sdk/viz";

export function drive(url: string, feed: HTMLElement, canvas: HTMLCanvasElement): () => void {
  const view = new SceneView();
  const overlay = new OverlayCanvas(canvas.getContext("2d") as CanvasRenderingContext2D);
  const attachment = attachToClient([view, overlay, new EventFeed(feed)], new FactoryClient(url));
  return () => {
    attachment.stop();
    view.dispose();
  };
}

/** A tray that has left, as it arrived and as it left: the labels of the stones certainly removed. */
export function report(tray: Tray, arrived: Frame, left: Frame): ReportLabel[] {
  const view = new TrayReportView({ gap: 0.2, scene: { board: true } });
  view.show(tray, arrived, left);
  const removed: string = REPORT_COLORS.removed;
  const marks = reportMarks(tray);
  return view.labels().filter((l) => l.color === removed && marks?.before.get(Number(l.text))?.certain === true);
}
