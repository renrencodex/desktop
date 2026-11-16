import { describe, expect, test } from "bun:test";

import { terminalScrollbarGeometry, terminalScrollbarOffsetAt } from "./terminal-scrollbar-model";

describe("terminal scrollbar model", () => {
  const state = {
    offsetLines: 50,
    historyLines: 100,
    viewportRows: 25,
    alternateScreen: false,
  };

  test("thumb size includes the visible viewport and position maps newest output to the bottom", () => {
    expect(terminalScrollbarGeometry(state, 100)).toEqual({
      thumbSize: 20,
      thumbTop: 40,
      travel: 80,
    });
    expect(terminalScrollbarGeometry({ ...state, offsetLines: 0 }, 100).thumbTop).toBe(80);
    expect(terminalScrollbarGeometry({ ...state, offsetLines: 100 }, 100).thumbTop).toBe(0);
  });

  test("track positions map to bounded offsets from live output", () => {
    const geometry = terminalScrollbarGeometry(state, 100);
    expect(terminalScrollbarOffsetAt(state, geometry, 10, 10)).toBe(100);
    expect(terminalScrollbarOffsetAt(state, geometry, 50, 10)).toBe(50);
    expect(terminalScrollbarOffsetAt(state, geometry, 100, 10)).toBe(0);
  });

  test("empty and short tracks remain finite", () => {
    const empty = terminalScrollbarGeometry({ ...state, historyLines: 0 }, 0);
    expect(empty).toEqual({ thumbSize: 0, thumbTop: 0, travel: 0 });
    expect(terminalScrollbarOffsetAt({ ...state, historyLines: 0 }, empty, 20, 5)).toBe(0);
  });
});
