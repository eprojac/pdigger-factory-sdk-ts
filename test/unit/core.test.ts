import { describe, expect, it } from "vitest";
import {
  BURST_GAP,
  InterpreterCore,
  Move,
  PushBurst,
  type Activity,
  type Frame,
  type StoneView,
  type WorldEvent,
  type WorldLayer,
} from "pdigger-factory-sdk";
import { eventKey, handStep, sortActivities } from "../../src/interpreter/core.js";
import { card, mkFrame, stone, type FrameSpec } from "../helpers/frames.js";

const texts = (acts: readonly Activity[]): string[] => acts.map((a) => a.describe());

describe("InterpreterCore", () => {
  it("starts empty", () => {
    const core = new InterpreterCore();
    const s = core.state;
    expect(s.session).toBeNull();
    expect(s.wall).toBeNull();
    expect(s.hands.left).toEqual({ state: null, stone: null, card: null });
    expect(core.summary().toJSON().first_t).toBeNull();
    expect(core.finish()).toEqual([]);
    expect(core.track(1)).toEqual([]);
  });

  it("follows a move from lift to place, with wall times and state", () => {
    const core = new InterpreterCore();
    core.setClock({ session: 1, rate: 0.8, anchor_wall: 1000, anchor_media: 0 });
    core.feed(mkFrame(10, { stones: [stone(5, [0, 0, 0.05])], cards: card("Idle") }));
    const u1 = core.feed(
      mkFrame(11, {
        stones: [stone(5, [0, 0, 0.05], { side: "left" })],
        events: [{ type: "lift", id: 5, side: "left" }],
        hands: { left: { state: "grasp", stone: 5 } },
      }),
    );
    expect(u1.events.map((e) => e.describe())).toEqual(["0:02.2 Left hand lifts stone 5"]);
    expect(u1.events[0]?.wall).toBeCloseTo(1000 + 2.2 / 0.8);
    expect(u1.events[0]?.stone?.id).toBe(5);
    expect(u1.state.openMoves.get(5)).toBeInstanceOf(Move);
    expect(u1.state.hands.left).toEqual({ state: "grasp", stone: 5, card: "Idle" });
    expect(u1.state.hands.right).toEqual({ state: null, stone: null, card: "Idle (right)" });
    core.feed(mkFrame(12, { stones: [stone(5, [0.1, 0, 0.05])], events: [{ type: "lift", id: 5, side: "right" }] }));
    core.feed(
      mkFrame(13, {
        stones: [stone(5, [0.2, 0, 0.05])],
        events: [
          { type: "carry", id: 5 },
          { type: "hinge", id: 5 },
        ],
      }),
    );
    const u = core.feed(mkFrame(15, { stones: [stone(5, [0.3, 0.4, 0.05])], events: [{ type: "place", id: 5 }] }));
    expect(texts(u.activities)).toEqual(["0:02.2 Both hands move stone 5 0.50 units in 0.8 s"]);
    const m = u.activities[0] as Move;
    expect(m.carried).toBe(true);
    expect(m.tipped).toBe(true);
    expect(m.from).toEqual([0, 0, 0.05]);
    expect(m.to).toEqual([0.3, 0.4, 0.05]);
    expect(m.end?.wall).toBeCloseTo(1000 + 3 / 0.8);
    expect(core.track(5).map((p) => p.g)).toEqual([10, 12, 13, 15]);
    const s = core.summary();
    expect(s.gaps).toBe(1);
    expect(s.moves.carried).toBe(1);
    expect(s.moves.meanDistance).toBe(0.5);
    expect(s.moves.meanDuration).toBe(0.8);
    expect(s.hands.left.grasp).toBe(0.2);
  });

  it("counts each frame's hands by its step: the media time since the session's previous frame", () => {
    const core = new InterpreterCore();
    const grasp = { left: { state: "grasp" as const, stone: null }, right: { state: "free" as const, stone: null } };
    // a plant camera: g counts the frames its worker released, 0.3 s apart (then 0.31 s, a frame without a world, 0.24 s)
    core.feed(mkFrame(100, { t: 30, hands: grasp }));
    core.feed(mkFrame(101, { t: 30.3, hands: grasp }));
    core.feed(mkFrame(102, { t: 30.61 }));
    core.feed(mkFrame(103, { t: 30.95, world: false }));
    core.feed(mkFrame(104, { t: 31.19, hands: grasp }));
    core.feed(mkFrame(104, { t: 31.19 })); // the same frame again: dropped, it adds nothing
    // after a gap (two frames the unit skipped, 8.81 s) a frame adds the session's previous step, 0.24 s
    core.feed(mkFrame(107, { t: 40, hands: grasp }));
    // a new session's first frame adds one grid frame, 0.2 s; after a gap, the previous step again
    core.feed(mkFrame(7, { session: 2, t: 1.4, hands: grasp }));
    core.feed(mkFrame(9, { session: 2, t: 1.8, hands: grasp }));
    const s = core.summary();
    expect(s.hands.left.grasp).toBe(1.38); // 200 + 300 + 240 + 240 + 200 + 200 ms
    expect(s.hands.left.free).toBe(0.31);
    expect(s.hands.right.free).toBe(1.69);
    expect(s.mediaSeconds).toBe(10.4);
  });

  it("steps a frame by its media time after the grid frame before it, else by the previous step", () => {
    expect(handStep(null, 5, 1)).toBe(200); // a session's first frame
    expect(handStep({ g: 4, t: 0.8, step: 200 }, 5, 1.1)).toBe(300);
    expect(handStep({ g: 4, t: 0.8, step: 250 }, 6, 1.1)).toBe(250); // after a gap
    expect(handStep({ g: 4, t: 0.8, step: 250 }, 5, Number.NaN)).toBe(250);
    expect(handStep({ g: 4, t: Number.NaN, step: 250 }, 5, 1)).toBe(250);
    expect(handStep({ g: 4, t: 0.8, step: 250 }, 5, Number.POSITIVE_INFINITY)).toBe(250);
    expect(handStep({ g: 4, t: Number.NEGATIVE_INFINITY, step: 250 }, 5, 1)).toBe(250);
    expect(handStep({ g: 4, t: 1, step: 250 }, 5, 1)).toBe(250); // a t not after the previous one
    expect(handStep({ g: 4, t: 1, step: 250 }, 5, 0.5)).toBe(250);
    expect(handStep({ g: 4, t: 1, step: 250 }, 5, 1.0004)).toBe(250); // below 1 ms
    expect(handStep({ g: 4, t: 1, step: 250 }, 5, 1.0006)).toBe(1);
    expect(handStep({ g: 4, t: 0, step: 250 }, 5, 2147483.6)).toBe(2147483600);
    expect(handStep({ g: 4, t: 0, step: 250 }, 5, 2147483.7)).toBe(250); // 2^31 ms or more
    expect(handStep({ g: 4, t: -1e308, step: 250 }, 5, 1e308)).toBe(250); // the difference overflows
  });

  it("gives no wall time without a matching clock", () => {
    const core = new InterpreterCore();
    expect(core.wallOf(1, 5)).toBeNull();
    core.setClock({ session: 2, rate: 1, anchor_wall: 0, anchor_media: 0 });
    expect(core.wallOf(1, 5)).toBeNull();
    core.setClock({ session: 1, rate: 0, anchor_wall: 0, anchor_media: 0 });
    expect(core.wallOf(1, 5)).toBeNull();
    core.setClock({ anchor_wall: 0, anchor_media: 0 });
    expect(core.wallOf(null, 5)).toBeNull();
    core.setClock(null);
    expect(core.wallOf(1, 5)).toBeNull();
  });

  it("keeps each session's newest clock: playing from the hold, paused from the pause, older states ignored", () => {
    const core = new InterpreterCore();
    const state = (session: number, revision: number, playing: boolean, wall: number) => ({
      session,
      revision,
      playing,
      rate: 0.5,
      anchor_wall: wall,
      anchor_media: 0,
      hold_until: wall + 1.5,
    });
    core.setClock(state(1, 1, true, 100));
    expect(core.wallOf(1, 1)).toBe(103.5);
    core.setClock(state(1, 2, false, 100));
    expect(core.wallOf(1, 1)).toBe(102);
    core.setClock(state(1, 1, true, 500));
    expect(core.wallOf(1, 1)).toBe(102);
    core.setClock(state(2, 3, true, 200));
    expect([core.wallOf(1, 1), core.wallOf(2, 1)]).toEqual([102, 203.5]);
    for (let s = 3; s < 10; s++) core.setClock(state(s, 1, true, 300));
    expect([core.wallOf(1, 1), core.wallOf(2, 1)]).toEqual([null, 203.5]);
    core.setClock({ session: 2, anchor_wall: 0, anchor_media: 0, rate: 1 });
    expect(core.wallOf(2, 1)).toBe(203.5);
    core.setClock({ session: 5, anchor_wall: 0, anchor_media: 0, rate: 1 });
    core.setClock({ session: 5, revision: 1, anchor_wall: 10, anchor_media: 0, rate: 1 });
    expect(core.wallOf(5, 1)).toBe(11);
    // states without a session or a revision: the newer one replaces the older
    core.setClock({ anchor_wall: 10, anchor_media: 0, rate: 1, playing: true });
    core.setClock({ anchor_wall: 20, anchor_media: 0, rate: 1 });
    expect(core.wallOf(null, 1)).toBe(21);
  });

  it("closes moves by drop, gone and delete; partial moves; deletes decided by the hand", () => {
    const core = new InterpreterCore();
    core.feed(mkFrame(1, { stones: [stone(1), stone(2), stone(3)] }));
    core.feed(
      mkFrame(2, {
        events: [
          { type: "lift", id: 1, side: "left" },
          { type: "lift", id: 2 },
          { type: "lift", id: 3, side: "right" },
        ],
      }),
    );
    const u = core.feed(
      mkFrame(3, {
        stones: [stone(1, [1, 1, 0])],
        events: [
          { type: "drop", id: 1 },
          { type: "gone", id: 2, side: "left" },
          { type: "delete", id: 2, why: "carried-away" },
          { type: "delete", id: 3, why: "absent" },
          { type: "delete", id: 99 },
          { type: "place", id: 4, side: "left" },
          { type: "confirm", id: 1 },
          { type: "split", id: 1, into: [1, 8] },
        ],
      }),
    );
    expect(texts(u.activities)).toEqual([
      "0:00.4 Left hand drops stone 1 after 0.2 s",
      "0:00.4 Left hand takes stone 2 away (0.2 s)",
      "0:00.4 Right hand lifts stone 3; it is removed after 0.2 s",
      "0:00.6 Left hand lifts stone 4 and sets it down (0.0 s) (joined mid-move)",
    ]);
    const s = core.summary();
    expect(s.moves).toMatchObject({ total: 4, dropped: 1, carriedAway: 1, removed: 1, placed: 1, partial: 1 });
    expect(s.moves.meanDistance).toBeNull();
    expect(s.events.delete).toBe(3);
  });

  it("groups pushes into bursts and closes stale ones before the frame's events", () => {
    const core = new InterpreterCore();
    core.feed(
      mkFrame(10, {
        events: [
          { type: "push", id: 3, side: "both" },
          { type: "push", id: 1, side: "both" },
        ],
      }),
    );
    core.feed(
      mkFrame(11, {
        events: [
          { type: "push", id: 3, side: "both" },
          { type: "push", id: 2, side: "left" },
        ],
      }),
    );
    core.feed(
      mkFrame(12, {
        events: [
          { type: "push", id: 4, why: "course" },
          { type: "push", id: 5 },
        ],
      }),
    );
    const u = core.feed(mkFrame(20, { events: [{ type: "push", id: 6, side: "both" }] }));
    expect(texts(u.activities)).toEqual([
      "0:02.0 Both hands push stones 1 and 3 (3 pushes in 0.2 s)",
      "0:02.2 Left hand pushes stone 2 (1 push)",
    ]);
    const fin = core.finish();
    expect(texts(fin)).toEqual(["0:04.0 Both hands push stone 6 (1 push)"]);
    const s = core.summary();
    expect(s.pushBursts).toEqual({ total: 3, pushes: 5, left: 1, right: 0, both: 2 });
    expect(BURST_GAP).toBe(1);
  });

  it("handles revisions: only unseen events, state from the newest revision, older revisions keep state", () => {
    const core = new InterpreterCore();
    core.feed(mkFrame(1, { stones: [stone(1)], events: [{ type: "new", id: 1 }] }));
    core.feed(mkFrame(2, { stones: [stone(1)] }));
    const rev = core.feed(
      mkFrame(2, { rev: 1, stones: [stone(1), stone(2)], events: [{ type: "new", id: 2 }], cards: card("Revised") }),
    );
    expect(rev.isRevision).toBe(true);
    expect(rev.events.map((e) => e.type)).toEqual(["new"]);
    expect(rev.state.stones.size).toBe(2);
    expect(rev.state.hands.left.card).toBeNull(); // the cards come only with new frames, never with a revision
    const old = core.feed(
      mkFrame(1, {
        rev: 1,
        stones: [stone(9)],
        events: [
          { type: "new", id: 1 },
          { type: "confirm", id: 1 },
        ],
      }),
    );
    expect(old.isRevision).toBe(true);
    expect(old.events.map((e) => e.type)).toEqual(["confirm"]);
    expect(old.state.stones.size).toBe(2);
    const dup = core.feed(mkFrame(1, { rev: 1 }));
    expect(dup.isDuplicate).toBe(true);
    expect(core.feed(mkFrame(2, { world: false })).isDuplicate).toBe(true);
    expect(core.feed(mkFrame(0, { rev: 3 })).isDuplicate).toBe(true);
    expect(core.summary().revisions).toBe(2);
  });

  it("starts a new session without the last one's card titles", () => {
    const core = new InterpreterCore();
    core.feed(mkFrame(1, { session: 1, stones: [stone(1)], cards: card("Holding a stone") }));
    expect(core.state.hands.left.card).toBe("Holding a stone");
    const next = core.feed(mkFrame(0, { session: 2, stones: [stone(1)] })); // the next video, no cards layer yet
    expect([next.state.hands.left.card, next.state.hands.right.card]).toEqual([null, null]);
    expect(
      core.feed(mkFrame(1, { session: 2, stones: [stone(1)], cards: card("Pushing a stone") })).state.hands.left.card,
    ).toBe("Pushing a stone");
  });

  it("closes a stale burst met on a revision whose time jumps", () => {
    const core = new InterpreterCore();
    core.feed(mkFrame(10, { t: 5, events: [{ type: "push", id: 1, side: "left" }] }));
    core.feed(mkFrame(11, { t: 5.1 }));
    const u = core.feed(
      mkFrame(11, {
        t: 9,
        rev: 1,
        events: [
          { type: "push", id: 2, side: "left" },
          { type: "push", side: "left" },
        ],
      }),
    );
    expect(texts(u.activities)).toEqual(["0:05.0 Left hand pushes stone 1 (1 push)"]);
    expect(texts(core.finish())).toEqual(["0:09.0 Left hand pushes stone 2 (2 pushes in 0.0 s)"]);
  });

  it("interrupts open moves at a session change and at finish; counts missing worlds and sessions", () => {
    const core = new InterpreterCore();
    core.feed(mkFrame(1, { session: 1, stones: [stone(1)] }));
    core.feed(
      mkFrame(2, {
        session: 1,
        events: [
          { type: "lift", id: 1, side: "left" },
          { type: "lift", side: "right" },
          { type: "push", id: 2, side: "right" },
        ],
      }),
    );
    core.feed(mkFrame(3, { session: 1, world: false }));
    const u = core.feed(mkFrame(100, { session: 2, video: "dry2" }));
    expect(texts(u.activities)).toEqual([
      "0:00.4 Right hand is still holding stone ? (0.0 s so far)",
      "0:00.4 Left hand is still holding stone 1 (0.0 s so far)",
      "0:00.4 Right hand pushes stone 2 (1 push)",
    ]);
    core.feed(mkFrame(101, { session: 2, video: "dry2", events: [{ type: "hinge", id: 4, side: "left" }] }));
    expect(texts(core.finish())).toEqual(["0:20.2 Left hand is still holding stone 4 (0.0 s so far)"]);
    const s = core.summary();
    expect(s.sessions).toBe(2);
    expect(s.missingWorld).toBe(1);
    expect(s.moves.interrupted).toBe(3);
    expect(s.moves.meanDuration).toBeNull();
    expect(s.mediaSeconds).toBe(0.6);
  });

  it("ends an interrupted move at the newest frame with a world", () => {
    const core = new InterpreterCore();
    core.feed(mkFrame(5, { session: 7, events: [{ type: "lift", id: 1 }] }));
    core.feed(mkFrame(6, { session: 7, world: false }));
    const [m] = core.finish() as Move[];
    expect(m?.end).toEqual(m?.start);
  });

  it("accepts sparse worlds and frames without a session", () => {
    const core = new InterpreterCore();
    const f = mkFrame(1);
    delete (f as { session?: number }).session;
    delete (f as { video?: string }).video;
    const w = f.world as unknown as Record<string, unknown>;
    delete w.stones;
    delete w.events;
    delete w.hands;
    delete w.stats;
    const u = core.feed(f);
    expect(u.state.session).toBeNull();
    expect(u.state.video).toBeNull();
    const g = mkFrame(2, {
      stones: [{ ...stone(3), id: "x" as unknown as number }],
      hands: { left: { state: "weird" as "free", stone: null } },
    });
    g.world!.events = [{} as never];
    const u2 = core.feed(g);
    expect(u2.state.stones.size).toBe(0);
    expect(u2.events[0]?.type).toBe("");
    expect(core.summary().events.other).toBe(1);
  });

  it("limits tracks by points and stones, and skips stones without a position", () => {
    const core = new InterpreterCore({ trackPoints: 2, trackStones: 2 });
    for (let g = 1; g <= 4; g++) {
      const s3 = { ...stone(3), solid: undefined } as unknown as ReturnType<typeof stone>;
      core.feed(mkFrame(g, { stones: [stone(1, [g, 0, 0]), stone(2, [0, 0, 0]), s3] }));
    }
    expect(core.track(1).map((p) => p.g)).toEqual([3, 4]);
    expect(core.track(2).map((p) => p.g)).toEqual([1]);
    core.feed(mkFrame(5, { stones: [stone(4, [1, 1, 1])] }));
    expect(core.track(2)).toEqual([]);
    expect(core.track(4)).toHaveLength(1);
  });

  it("prunes per-frame bookkeeping on long sessions", () => {
    const core = new InterpreterCore();
    for (let g = 0; g <= 8200; g++) core.feed(mkFrame(g, { t: g / 5 }));
    expect(core.feed(mkFrame(10, { rev: 5, events: [{ type: "new", id: 1 }] })).isDuplicate).toBe(true);
    expect(core.summary().frames).toBe(8201);
  });

  it("keeps the tray links of the frames it keeps for revisions", () => {
    // 2.4: the tray links are pruned with the revisions: the oldest frame kept still gives a revision the tray stone
    // from before it, a frame older than that is a duplicate, and the links kept stay bounded
    const on = [stone(1, [-0.6, 0, 0.05]), stone(2), stone(3, [0.6, 0, 0.05])];
    const still = (g: number, spec: FrameSpec = {}): Frame =>
      mkFrame(g, { stones: on, stats: { stones: 3, confirmed: 3 }, ...spec });
    const core = new InterpreterCore();
    for (let g = 0; g <= 8192; g++) core.feed(still(g));
    // the tray arrives at g4 (taken at g10, its visit); more than 2 x 4096 frames kept prune at g8192, keeping g4096 on
    expect(core.state.tray?.stones[0]?.id).toBe("s1t0.8-1-1");
    const links = (core as unknown as { links: Map<number, unknown> }).links;
    expect([links.size, links.has(4096), links.has(4095)]).toEqual([4097, true, false]);
    const edge = core.feed(still(4096, { rev: 1, events: [{ type: "confirm", id: 1 }] }));
    expect([edge.isRevision, edge.events.map((e) => e.trayStone)]).toEqual([true, ["s1t0.8-1-1"]]);
    const older = core.feed(still(4095, { rev: 1, events: [{ type: "confirm", id: 1 }] }));
    expect([older.isDuplicate, older.events]).toEqual([true, []]);
  });

  it("takes frames without session, video, stones or stone ids", () => {
    const sparse = (g: number, events: Partial<WorldEvent>[], stones?: StoneView[]): Frame => {
      const f = mkFrame(g, { events, stones: stones ?? [] });
      delete (f as Partial<Frame>).session;
      delete (f as Partial<Frame>).video;
      if (stones === undefined) delete (f.world as Partial<WorldLayer>).stones;
      return f;
    };
    const anonymous = { ...stone(0), id: undefined } as unknown as StoneView;
    const core = new InterpreterCore();
    core.feed(mkFrame(1, { session: 4 }));
    const u = core.feed(
      sparse(
        2,
        [
          { type: "lift", id: 6, side: "left" },
          { type: "push", id: 2, side: "right" },
        ],
        [anonymous, stone(6)],
      ),
    );
    expect(u.state.session).toBeNull();
    expect(u.state.video).toBeNull();
    expect(u.events.map((e) => [e.session, e.video, e.stone?.id])).toEqual([
      [null, null, 6],
      [null, null, undefined],
    ]);
    const done = core.feed(
      sparse(3, [
        { type: "place", id: 6, side: "left" },
        { type: "drop", id: 8, side: "left" },
        { type: "drop", id: 8, side: "left" },
      ]),
    );
    expect(texts(done.activities)).toEqual([
      "0:00.4 Left hand lifts stone 6 and sets it down (0.2 s)",
      "0:00.6 Left hand drops stone 8 after 0.0 s (joined mid-move)",
      "0:00.6 Left hand drops stone 8 after 0.0 s (joined mid-move)",
    ]);
    expect(done.events[0]?.stone).toBeNull();
    expect(core.state.openMoves.size).toBe(0);
    // as the golden files have it, a stream without a session has nothing to close: the open burst stays open
    expect(core.finish()).toEqual([]);
  });

  it("counts frames whose world has no rev", () => {
    const core = new InterpreterCore();
    core.feed(mkFrame(1, { rev: 0 }));
    expect(core.feed(mkFrame(1, { rev: 0 })).isDuplicate).toBe(true);
  });
});

describe("eventKey and sortActivities", () => {
  it("keys events by type, id, side and into", () => {
    expect(eventKey({ type: "split", id: 1, into: [1, 2] })).toBe('["split",1,null,[1,2]]');
    expect(eventKey({} as never)).toBe("[null,null,null,null]");
  });
  it("sorts by end g, start g, kind, first stone and hand", () => {
    const ref = (g: number) => ({ g, t: g / 5, wall: null });
    const move = (id: number | null, hand: string | null, start: number, end: number): Move => {
      const m = new Move({
        stoneId: id,
        hand,
        start: ref(start),
        from: null,
        tipped: false,
        partial: false,
        session: 1,
        video: "v",
      });
      m.end = ref(end);
      return m;
    };
    const burst = (hand: string, stones: number[], start: number, end: number): PushBurst => {
      const b = new PushBurst({ hand, start: ref(start), session: 1, video: "v" });
      b.stones.push(...stones);
      b.end = ref(end);
      return b;
    };
    const list: Activity[] = [
      burst("left", [], 1, 5),
      move(2, "right", 1, 5),
      move(2, "left", 1, 5),
      move(null, null, 1, 5),
      move(1, "left", 2, 5),
      burst("right", [3], 1, 4),
      move(9, "left", 1, 5),
    ];
    const order = sortActivities(list).map(
      (a) => `${a.kind}:${a.kind === "move" ? a.stoneId : a.stones.join("+")}:${a.hand}`,
    );
    expect(order).toEqual([
      "push:3:right",
      "move:null:null",
      "move:2:left",
      "move:2:right",
      "move:9:left",
      "push::left",
      "move:1:left",
    ]);
  });
});
