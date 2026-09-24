import { describe, it, expect } from "vitest";
import { createCorpusLane } from "../../src/lib/corpus-lane";

// The lane exists for one property: no two corpus-sized requests are in the Pages Function isolate at
// the same moment. Everything else it does is in service of not making that property expensive.
describe("createCorpusLane", () => {
  const deferred = () => {
    let settle!: (v: string) => void;
    let fail!: (e: unknown) => void;
    const promise = new Promise<string>((res, rej) => ((settle = res), (fail = rej)));
    return { promise, settle, fail };
  };

  it("never runs two tasks at once", async () => {
    const lane = createCorpusLane();
    let inFlight = 0;
    let peak = 0;
    const task = async () => {
      peak = Math.max(peak, ++inFlight);
      await Promise.resolve();
      inFlight--;
    };

    await Promise.all([lane.run(task), lane.run(task), lane.run(task)]);

    expect(peak).toBe(1);
  });

  it("holds a task until the one ahead of it finishes", async () => {
    const lane = createCorpusLane();
    const first = deferred();
    const ran: string[] = [];

    void lane.run(async () => {
      ran.push("first");
      await first.promise;
    });
    const second = lane.run(async () => void ran.push("second"));

    await Promise.resolve();
    expect(ran).toEqual(["first"]);

    first.settle("done");
    await second;
    expect(ran).toEqual(["first", "second"]);
  });

  it("gives the caller the task's own result", async () => {
    const lane = createCorpusLane();
    await expect(lane.run(async () => "warmed")).resolves.toBe("warmed");
    await expect(lane.run(async () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
  });

  // A warm that fails is the whole reason: it must not take the sweep queued behind it with it.
  it("does not strand the queue behind a task that throws", async () => {
    const lane = createCorpusLane();
    const ran: string[] = [];

    const failing = lane.run(async () => {
      ran.push("failing");
      throw new Error("offline");
    });
    const after = lane.run(async () => void ran.push("after"));

    await expect(failing).rejects.toThrow("offline");
    await after;
    expect(ran).toEqual(["failing", "after"]);
  });

  it("runs them in the order they were queued", async () => {
    const lane = createCorpusLane();
    const ran: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => lane.run(async () => void ran.push(n))));
    expect(ran).toEqual([1, 2, 3, 4]);
  });
});
