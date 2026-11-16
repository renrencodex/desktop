import { expect, spyOn, test } from "bun:test";
import { combineAbortSignals } from "./abort-signals";

test("either source cancels the composed signal and detaches every source", () => {
  for (const index of [0, 1]) {
    const sources = [new AbortController(), new AbortController()];
    const removals = sources.map((source) => spyOn(source.signal, "removeEventListener"));
    const combined = combineAbortSignals(sources.map((source) => source.signal));
    expect(combined.signal.aborted).toBe(false);
    sources[index]!.abort();
    expect(combined.signal.aborted).toBe(true);
    for (const remove of removals) {
      expect(remove).toHaveBeenCalledTimes(1);
      remove.mockRestore();
    }
  }
});

test("already-aborted input cancels immediately without installing listeners", () => {
  const live = new AbortController();
  const cancelled = new AbortController();
  cancelled.abort();
  const add = spyOn(live.signal, "addEventListener");
  const combined = combineAbortSignals([live.signal, cancelled.signal]);
  expect(combined.signal.aborted).toBe(true);
  expect(add).not.toHaveBeenCalled();
  combined.dispose();
  add.mockRestore();
});

test("normal completion disposes once, including duplicated sources", () => {
  const source = new AbortController();
  const add = spyOn(source.signal, "addEventListener");
  const remove = spyOn(source.signal, "removeEventListener");
  const combined = combineAbortSignals([source.signal, source.signal]);
  expect(add).toHaveBeenCalledTimes(1);
  combined.dispose();
  combined.dispose();
  expect(remove).toHaveBeenCalledTimes(1);
  source.abort();
  expect(combined.signal.aborted).toBe(false);
  add.mockRestore();
  remove.mockRestore();
});
