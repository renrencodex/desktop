import { expect, test } from "bun:test";

import { createLatestSaveQueue } from "./latest-save-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("native layout saves cannot overtake an exclusive terminal close", async () => {
  const calls: string[] = [];
  const activeSave = deferred<string>();
  const latestSave = deferred<string>();
  const closeGate = deferred<void>();
  const queue = createLatestSaveQueue<string>({
    delayMs: 0,
    save: (value) => {
      calls.push(value);
      return calls.length === 1 ? activeSave.promise : latestSave.promise;
    },
    onSaved: () => {},
    onStatus: () => {},
  });

  queue.schedule("active");
  await Bun.sleep(5);
  queue.schedule("superseded");
  let closeStarted = false;
  const close = queue.runExclusive(async () => {
    closeStarted = true;
    queue.schedule("rebased-after-close");
    await closeGate.promise;
  });
  await Bun.sleep(5);
  expect(closeStarted).toBe(false);
  expect(calls).toEqual(["active"]);

  activeSave.resolve("active");
  await Bun.sleep(5);
  expect(closeStarted).toBe(true);
  expect(calls).toEqual(["active"]);

  closeGate.resolve();
  await close;
  await Bun.sleep(5);
  expect(calls).toEqual(["active", "rebased-after-close"]);
  latestSave.resolve("rebased-after-close");
});

test("native terminal close can discard the stale pending full-layout save", async () => {
  const calls: string[] = [];
  const queue = createLatestSaveQueue<string>({
    delayMs: 10_000,
    save: async (value) => {
      calls.push(value);
      return value;
    },
    onSaved: () => {},
    onStatus: () => {},
  });

  queue.schedule("layout-before-close");
  await queue.runExclusive(async () => queue.discardPending());
  await Bun.sleep(5);
  expect(calls).toEqual([]);
});
