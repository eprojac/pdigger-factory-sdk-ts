import { describe, expect, it, vi } from "vitest";
import { clientOf, fixtureFake, rejection } from "../helpers/fake.js";

// Rule 9 skips an event that does not decode. A fault of the SDK itself while it reads an event is not that: it ends
// the stream. The fault is made here: once armed, the look check throws on grid frame 405 (the fake reads its recording
// through the same check, so it is armed after the fake is made).
const fault = vi.hoisted(() => ({ armed: false }));
vi.mock("../../src/internal/looks.js", async (importOriginal) => {
  const real = await importOriginal<{ cleanFrame: (frame: unknown) => unknown }>();
  return {
    ...real,
    cleanFrame: (frame: unknown): unknown => {
      if (fault.armed && (frame as { g?: unknown }).g === 405) throw new TypeError("a fault of the SDK");
      return real.cleanFrame(frame);
    },
  };
});

describe("streams.frames", () => {
  it("ends on a fault of the SDK while it reads an event, which it does not skip as an event that does not decode", async () => {
    const fake = await fixtureFake("joined-mid-move", { endOfData: "close" });
    fault.armed = true;
    const seen: number[] = [];
    const onDecodeError = vi.fn();
    const err = await rejection(
      (async () => {
        for await (const i of clientOf(fake).streams.frames({ resume: false, onDecodeError })) {
          if (i.kind === "frame") seen.push(i.frame.g);
        }
      })(),
    );
    expect([err instanceof TypeError, (err as Error).message]).toEqual([true, "a fault of the SDK"]);
    expect(seen).toEqual([399, 400, 401, 402, 403, 404]);
    expect(onDecodeError).not.toHaveBeenCalled();
  });
});
