import { expect, test } from "bun:test";
import { createPreviewLayoutCoordinator } from "./native-preview-layout";

test("split previews prepare together before layout changes and finish afterwards", async () => {
  const coordinator = createPreviewLayoutCoordinator();
  const calls: string[] = [];
  const pending = Promise.withResolvers<void>();
  for (const id of ["a", "b"])
    coordinator.register({
      async prepare() {
        calls.push(`prepare-${id}`);
        await pending.promise;
      },
      async finish() {
        calls.push(`finish-${id}`);
      },
    });
  const changing = coordinator.change(() => calls.push("layout"));
  expect(calls).toEqual(["prepare-a", "prepare-b"]);
  pending.resolve();
  await changing;
  expect(calls).toEqual(["prepare-a", "prepare-b", "layout", "finish-a", "finish-b"]);
});

test("new intent cancels old preparation; late completion never applies old layout", async () => {
  const coordinator = createPreviewLayoutCoordinator();
  const calls: string[] = [];
  const pending = Promise.withResolvers<void>();
  let first = true;
  let oldSignal: AbortSignal | undefined;
  coordinator.register({
    async prepare(signal) {
      if (first) {
        first = false;
        oldSignal = signal;
        await pending.promise;
      }
    },
    async finish() {
      calls.push("finished");
    },
  });
  const old = coordinator.change(() => calls.push("old"));
  await coordinator.change(() => calls.push("latest"));
  expect(oldSignal?.aborted).toBe(true);
  pending.resolve();
  await old;
  expect(calls).toEqual(["latest", "finished"]);
});

test("failed and removed participants cannot block sidebar switching", async () => {
  const coordinator = createPreviewLayoutCoordinator();
  const calls: string[] = [];
  const remove = coordinator.register({
    async prepare() {
      calls.push("failed");
      throw Error("capture");
    },
    async finish() {
      calls.push("finish");
    },
  });
  await coordinator.change(() => calls.push("layout"));
  remove();
  await coordinator.change(() => calls.push("no-browser"));
  expect(calls).toEqual(["failed", "layout", "finish", "no-browser"]);
});
