/**
 * `EventFeed` (SDK-DESIGN.md section 11): the `describe()` lines of events and activities in a DOM element, newest
 * first, each marked with its hand's colour.
 *
 * @module
 */
import type { Activity, FactoryEvent, Update } from "../interpreter/types.js";
import { handColor, palette, type Palette } from "./colors.js";

/** Options of an {@link EventFeed}. */
export interface EventFeedOptions {
  /** Lines kept (default 200); older lines are removed. */
  max?: number;
  colors?: Partial<Palette>;
  /** Also list events (default true); false shows activities only. */
  events?: boolean;
  /** Also list activities (default true). */
  activities?: boolean;
  /** Event types left out (default none), e.g. `["new", "confirm", "freeze"]` for a calmer feed. */
  skip?: readonly string[];
}

/** One line of the feed. */
export type FeedItem = FactoryEvent | Activity | string;

function isActivity(item: FeedItem): item is Activity {
  return typeof item === "object" && "kind" in item && (item.kind === "move" || item.kind === "push");
}

/** A live list of what happened, for a page. */
export class EventFeed {
  /** The element the lines are in. */
  readonly element: HTMLElement;
  readonly colors: Palette;
  private readonly options: Required<Omit<EventFeedOptions, "colors">>;

  constructor(element: HTMLElement, options: EventFeedOptions = {}) {
    this.element = element;
    this.colors = palette(null, options.colors);
    this.options = {
      max: options.max ?? 200,
      events: options.events ?? true,
      activities: options.activities ?? true,
      skip: options.skip ?? [],
    };
    element.classList.add("pdigger-feed");
  }

  /** Lines shown. */
  get size(): number {
    return this.element.children.length;
  }

  /** The text of the lines, newest first. */
  get lines(): string[] {
    return [...this.element.children].map((c) => c.textContent);
  }

  /** Adds one line at the top: an event, an activity, or plain text. Returns its element. */
  add(item: FeedItem): HTMLElement {
    const doc = this.element.ownerDocument;
    const line = doc.createElement("div");
    line.className = "pdigger-feed-line";
    let hand: string | null = null;
    if (typeof item === "string") {
      line.textContent = item;
      line.dataset.kind = "text";
    } else {
      line.textContent = item.describe();
      hand = item.hand;
      if (isActivity(item)) {
        line.dataset.kind = item.kind;
        line.classList.add("pdigger-activity");
      } else {
        line.dataset.kind = "event";
        line.dataset.type = item.type;
      }
      line.dataset.g = String(isActivity(item) ? item.start.g : item.g);
    }
    line.dataset.hand = hand ?? "none";
    line.style.borderLeft = `4px solid ${handColor(hand, this.colors)}`;
    line.style.paddingLeft = "8px";
    this.element.insertBefore(line, this.element.firstChild);
    while (this.element.children.length > this.options.max) this.element.lastElementChild?.remove();
    return line;
  }

  /** Adds an update's events (in world order) and then its activities, so the newest ends on top. */
  addUpdate(update: Pick<Update, "events" | "activities">): void {
    if (this.options.events) {
      for (const e of update.events) if (!this.options.skip.includes(e.type)) this.add(e);
    }
    if (this.options.activities) for (const a of update.activities) this.add(a);
  }

  /** Removes every line. */
  clear(): void {
    while (this.element.firstChild) this.element.removeChild(this.element.firstChild);
  }
}
