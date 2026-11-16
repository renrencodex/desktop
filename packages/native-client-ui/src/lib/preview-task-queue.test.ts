import { describe, expect, test } from "bun:test";
import { createPreviewTaskQueue } from "./preview-task-queue";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture() {
  let tail = Promise.resolve();
  const calls: string[] = [];
  const enqueue = (task: () => Promise<void>) => {
    const next = tail.catch(() => {}).then(task);
    tail = next;
    return next;
  };
  const queue = createPreviewTaskQueue(enqueue, () => calls.push("error"));
  const task = (name: string) => async () => {
    calls.push(name);
  };
  return { calls, enqueue, queue, task };
}

describe("coalesced preview geometry", () => {
  test("only the latest geometry executes if the queue has not started", async () => {
    const { queue, task, calls } = fixture();
    queue.request(task("obsolete"));
    queue.request(task("latest"));
    await tick();
    expect(calls).toEqual(["latest"]);
  });

  test("one in-flight resize, latest pending resize, and no bypass of lifecycle work", async () => {
    const { queue, enqueue, task, calls } = fixture();
    const pending = Promise.withResolvers<void>();
    queue.request(async () => {
      calls.push("start");
      await pending.promise;
      calls.push("end");
    });
    await tick();
    queue.request(task("obsolete"));
    queue.request(task("latest"));
    const closed = enqueue(task("hide"));
    pending.resolve();
    await closed;
    await tick();
    expect(calls).toEqual(["start", "end", "hide", "latest"]);
  });

  test("clearing removes pending work and rejection does not poison future updates", async () => {
    const { queue, task, calls } = fixture();
    queue.request(task("cancelled"));
    queue.clear();
    await tick();
    expect(calls).toEqual([]);
    queue.request(async () => {
      throw Error("native failure");
    });
    await tick();
    queue.request(task("recovered"));
    await tick();
    expect(calls).toEqual(["error", "recovered"]);
  });
});
