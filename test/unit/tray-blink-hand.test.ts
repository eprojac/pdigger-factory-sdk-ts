import { describe, expect, it } from "vitest";
import { InterpreterCore, type StoneView } from "pdigger-factory-sdk";
import { mkFrame, stone } from "../helpers/frames.js";

/** Two neighbouring stones; stone 1 disappears at frame 13 and returns at 14. */
function run(placeFrame?: number, contenderAt?: number) {
  const core = new InterpreterCore();
  const pair = [0, 0.35].map((x, i) =>
    stone(i + 1, [x, 0, 0.05], {
      shape: "frozen",
      solid: {
        pos: [x, 0, 0.05],
        dims: contenderAt !== undefined && i === 0 ? [0.09, 0.05, 0.046] : [0.3, 0.2, 0.1],
        q: [0, 0, 0, 1],
      },
    }),
  );
  for (let g = 0; g <= 22; g++) {
    const stones: StoneView[] = g === 13 ? pair.slice(1) : [...pair];
    if (contenderAt !== undefined && g >= contenderAt)
      stones.push(
        stone(3, [0.12, 0, 0.05], {
          shape: "frozen",
          solid: { pos: [0.12, 0, 0.05], dims: [0.09, 0.05, 0.046], q: [0, 0, 0, 1] },
        }),
      );
    core.feed(
      mkFrame(g, {
        stones,
        stats: { stones: stones.length, confirmed: stones.length },
        events: g === placeFrame ? [{ type: "place", id: 2, side: "left" }] : [],
      }),
    );
  }
  core.end();
  return core.trays()[0]!;
}

describe("identity across a brief omission", () => {
  it.each([12, 14])("keeps both identity doubts when a hand placed the neighbour at frame %i", (g) => {
    const tray = run(g);
    expect(tray.stones.map((s) => [s.worldId, s.sure])).toEqual([
      [1, false],
      [2, false],
    ]);
    expect(tray.facts.filter((f) => f.kind === "unsure").map((f) => f.code)).toEqual(["found_again", "appeared"]);
  });

  it("keeps the untouched links when both observations are free of hand work", () => {
    const tray = run();
    expect(tray.stones.map((s) => [s.worldId, s.sure, s.touched])).toEqual([
      [1, true, null],
      [2, true, null],
    ]);
  });

  it("does not restore certainty when another plausible track appears at recovery", () => {
    const tray = run(undefined, 14);
    expect(tray.stones.find((s) => s.id.endsWith("-1-1"))?.sure).toBe(false);
  });

  it("keeps the original link beside a compatible neighbour that was there throughout", () => {
    const tray = run(undefined, 0);
    expect(tray.stones.find((s) => s.id.endsWith("-1-1"))).toMatchObject({ worldId: 1, sure: true, touched: null });
  });
});

describe("tray timing through an incomplete inventory", () => {
  it.each([false, true])("uses detections at departure when two frames share a time (hand work: %s)", (worked) => {
    const core = new InterpreterCore();
    for (let g = 0; g <= 12; g++) {
      const stones = [stone(1, [0, 0, 0.05], { detected: g !== 12 }), stone(2, [0.35, 0, 0.05])];
      core.feed(
        mkFrame(g, {
          t: Math.min(g, 11) / 5,
          stones,
          stats: { stones: 2, confirmed: 2 },
          events: worked && g === 12 ? [{ type: "place", id: 2, side: "left" }] : [],
        }),
      );
    }
    core.end();
    const tray = core.trays()[0]!;
    expect(tray.leaving?.g).toBe(12);
    expect(tray.stones[0]).toMatchObject({ worldId: 1, place: [0, 0], leftPlace: null });
    expect(tray.stones[1]!.leftPlace).toEqual([0.35, 0]);
  });

  it("retains detected positions when arrival is the leaving frame", () => {
    const core = new InterpreterCore();
    for (let g = 0; g <= 12; g++) {
      const stones = [stone(1, [0, 0, 0.05], { detected: false }), stone(2, [0.35, 0, 0.05])];
      core.feed(
        mkFrame(g, {
          stones,
          stats: { stones: 2, confirmed: g < 12 ? 1 : 2 },
        }),
      );
    }
    core.end();
    const tray = core.trays()[0]!;
    expect(tray.arrived?.g).toBe(12);
    expect(tray.leaving).toEqual(tray.arrived);
    expect(tray.stones.map((s) => s.leftPlace)).toEqual([null, [0.35, 0]]);
  });

  it("waits for the briefly missing row before choosing an arrival", () => {
    const core = new InterpreterCore();
    const rows = [stone(1), stone(2, [0.35, 0, 0.05])];
    for (let g = 0; g <= 11; g++) {
      const stones = g === 4 ? rows.slice(1) : rows;
      core.feed(mkFrame(g, { stones, stats: { stones: stones.length, confirmed: stones.length } }));
    }
    core.end();
    expect(core.trays()[0]!.arrived?.g).toBe(5);
    expect(core.trays()[0]!.stones.map((s) => [s.worldId, s.added])).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  it("rejects a departure frame missing an unlinked, undetected track without adding it to the account", () => {
    const core = new InterpreterCore();
    const kept = stone(2, [0.5, 0, 0.05], { mode: "kept", detected: false });
    for (let g = 0; g <= 13; g++) {
      const stones = g === 12 ? [stone(1), kept] : [stone(1)];
      core.feed(mkFrame(g, { stones, stats: { stones: stones.length, confirmed: stones.length } }));
    }
    core.end();
    const tray = core.trays()[0]!;
    expect(tray.leaving?.g).toBe(12);
    expect(tray.stones.map((s) => [s.worldId, s.sure])).toEqual([[1, true]]);
  });
});

describe("a masked calm moment on a later visit", () => {
  function visit(closeByNextTray: boolean) {
    const core = new InterpreterCore();
    const moving = (g: number) => {
      const f = mkFrame(g);
      f.world!.motion = "moving";
      core.feed(f);
    };
    for (let g = 0; g <= 26; g++) {
      if (g === 13) {
        moving(g);
        continue;
      }
      const second = stone(2, [0.6, 0, 0.05], { detected: g < 14, mode: g < 14 ? "seen" : "kept" });
      const stones = g === 25 ? [second] : [stone(1, [g === 26 ? 0.04 : 0, 0, 0.05]), second];
      const events = (g >= 14 && g <= 22) || g === 26 ? [{ type: "new" as const, id: 9 }] : [];
      core.feed(mkFrame(g, { stones, events, stats: { stones: stones.length, confirmed: stones.length } }));
    }
    if (closeByNextTray) {
      moving(27);
      for (let g = 28; g <= 39; g++) core.feed(mkFrame(g, { stones: [stone(90)], stats: { stones: 1, confirmed: 1 } }));
    }
    core.end();
    return core.trays()[0]!;
  }

  it.each([false, true])("keeps the clean observation from the current visit through close (next tray %s)", (next) => {
    const tray = visit(next);
    expect(tray.leaving?.g).toBe(24);
    expect(tray.stones.find((s) => s.worldId === 1)).toMatchObject({ leftPlace: [0, 0], sure: true });
    expect(tray.stones.find((s) => s.worldId === 2)).toMatchObject({ leftPlace: null, sure: false });
    expect(tray.facts.filter((f) => f.kind === "unsure").map((f) => f.code)).toEqual(["unseen"]);
  });
});

describe("negative sightings at separate calm moments", () => {
  function inspect(last: number, ordinarySettle = false) {
    const core = new InterpreterCore();
    for (let g = 0; g <= last; g++) {
      const missing = g === 14 || g === 18;
      const seen = g < 12 || g === 15;
      const second = stone(2, [0.6, 0, 0.05], { detected: seen, mode: seen ? "seen" : "kept" });
      const stones = missing ? [second] : [stone(1), second];
      const events = g === 11 || (g === 15 && !ordinarySettle) ? [{ type: "new" as const, id: 20 }] : [];
      core.feed(mkFrame(g, { stones, events, stats: { stones: stones.length, confirmed: stones.length } }));
    }
    core.end();
    return core.trays()[0]!;
  }
  it("uses explicit non-detections in two independent partial inventories even with a sight between them", () => {
    const tray = inspect(18);
    expect(tray.stones.find((s) => s.worldId === 2)?.sure).toBe(false);
    expect(tray.facts.filter((f) => f.kind === "unsure").map((f) => [f.code, f.g])).toEqual([["unseen", 18]]);
  });
  it("does not double-count a partial reading with the closing frame or a delayed settle in its own run", () => {
    for (const tray of [inspect(14), inspect(15, true)]) {
      expect(tray.stones.find((s) => s.worldId === 2)?.sure).toBe(true);
    }
  });
});

it("does not acquire a briefly omitted world track that was always off the board", () => {
  const core = new InterpreterCore();
  const board = { cx: 0, cy: 0, theta: 0, hw: 1, hh: 1 };
  for (let g = 0; g <= 14; g++) {
    const stones = g === 13 ? [stone(1)] : [stone(1), stone(2, [4, 0, 0.05])];
    core.feed(mkFrame(g, { board, stones, stats: { confirmed: stones.length, stones: stones.length } }));
  }
  core.end();
  expect(core.trays()[0]!.stones.map((s) => s.worldId)).toEqual([1]);
});
