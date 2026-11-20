import { describe, expect, test } from "bun:test";
import type { CanvasRenderer } from "ghostty-web";

import {
  installGhosttyBackgroundPixelAlignment,
  installGhosttySelectionAutoScrollBoundary,
} from "./terminal-canvas-selection";

interface FillCall {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

interface Transform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

interface TestCell {
  width: number;
  background?: string;
}

function fixture(
  transform: Transform,
  selected: (column: number, row: number) => boolean = () => false,
  drawDecoration = false,
) {
  const fills: FillCall[] = [];
  let metricReads = 0;
  let transformReads = 0;
  const context = {
    fillStyle: "#000000",
    getTransform: () => {
      transformReads += 1;
      return transform;
    },
    fillRect(x: number, y: number, width: number, height: number) {
      fills.push({ x, y, width, height, color: this.fillStyle });
    },
  };
  const renderer = {
    getCanvas: () => ({ getContext: () => context }),
    getMetrics: () => {
      metricReads += 1;
      return { width: 7, height: 15 };
    },
    renderLine(line: TestCell[], row: number, columns: number) {
      context.fillStyle = "#111610";
      context.fillRect(0, row * 15, columns * 7, 15);
      for (let column = 0; column < line.length; column++) {
        const cell = line[column]!;
        if (cell.width !== 0) this.renderCellBackground(cell, column, row);
      }
      if (drawDecoration) {
        context.fillStyle = "#ff00ff";
        context.fillRect(0.25, row * 15 + 0.25, 1.5, 1.5);
      }
    },
    renderCellBackground(cell: TestCell, column: number, row: number) {
      const color = selected(column, row) ? "#214283" : cell.background;
      if (!color) return;
      context.fillStyle = color;
      context.fillRect(column * 7, row * 15, cell.width * 7, 15);
    },
  };
  const originalFillRect = context.fillRect;
  const originalRenderLine = renderer.renderLine;
  return {
    context,
    fills,
    originalFillRect,
    originalRenderLine,
    renderer: renderer as unknown as CanvasRenderer,
    rawRenderer: renderer,
    get metricReads() {
      return metricReads;
    },
    get transformReads() {
      return transformReads;
    },
    paintLine: (cells: TestCell[], row: number) => renderer.renderLine(cells, row, cells.length),
  };
}

function deviceEdges(call: FillCall, transform: Transform) {
  return {
    left: call.x * transform.a + transform.e,
    right: (call.x + call.width) * transform.a + transform.e,
    top: call.y * transform.d + transform.f,
    bottom: (call.y + call.height) * transform.d + transform.f,
  };
}

describe("installGhosttyBackgroundPixelAlignment", () => {
  test("selection and ANSI backgrounds share integer device-pixel edges", () => {
    const transform = { a: 1.25, b: 0, c: 0, d: 1.25, e: 0, f: 0 };
    const target = fixture(transform, (column) => column === 0);
    installGhosttyBackgroundPixelAlignment(target.renderer);

    const line = [
      { width: 1, background: "#89d1dc" },
      { width: 1, background: "#89d1dc" },
    ];
    target.paintLine(line, 0);
    target.paintLine(line, 1);

    const selection = target.fills.filter((call) => call.color === "#214283");
    const ansi = target.fills.filter((call) => call.color === "#89d1dc");
    expect(selection).toHaveLength(2);
    expect(ansi).toHaveLength(2);
    const selectedAbove = deviceEdges(selection[0]!, transform);
    const selectedBelow = deviceEdges(selection[1]!, transform);
    const ansiAbove = deviceEdges(ansi[0]!, transform);
    expect(selectedAbove.right).toBe(ansiAbove.left);
    expect(selectedAbove.bottom).toBe(selectedBelow.top);
    expect(
      [...selection, ...ansi].every((call) =>
        Object.values(deviceEdges(call, transform)).every(Number.isInteger),
      ),
    ).toBe(true);
    expect(target.metricReads).toBe(2);
    expect(target.transformReads).toBe(2);
  });

  test("wide glyph backgrounds retain shared boundaries with a translated transform", () => {
    const transform = { a: 1.5, b: 0, c: 0, d: 1.5, e: 0.25, f: 0.5 };
    const target = fixture(transform);
    installGhosttyBackgroundPixelAlignment(target.renderer);

    target.paintLine(
      [{ width: 2, background: "#89d1dc" }, { width: 0 }, { width: 1, background: "#89d1dc" }],
      0,
    );

    const ansi = target.fills.filter((call) => call.color === "#89d1dc");
    expect(ansi).toHaveLength(2);
    const wide = deviceEdges(ansi[0]!, transform);
    const next = deviceEdges(ansi[1]!, transform);
    expect(wide.right).toBe(next.left);
    expect(Object.values(wide).every(Number.isInteger)).toBe(true);
    expect(target.metricReads).toBe(1);
    expect(target.transformReads).toBe(1);
  });

  test("non-cell rectangles keep their original geometry", () => {
    const transform = { a: 1.25, b: 0, c: 0, d: 1.25, e: 0, f: 0 };
    const target = fixture(transform, () => false, true);
    installGhosttyBackgroundPixelAlignment(target.renderer);

    target.paintLine([{ width: 1, background: "#89d1dc" }], 0);

    expect(target.fills.find((call) => call.color === "#ff00ff")).toEqual({
      x: 0.25,
      y: 0.25,
      width: 1.5,
      height: 1.5,
      color: "#ff00ff",
    });
  });

  test("unsupported transforms preserve Ghostty's original rectangles", () => {
    const target = fixture({ a: 1.25, b: 0.1, c: 0, d: 1.25, e: 0, f: 0 });
    installGhosttyBackgroundPixelAlignment(target.renderer);
    target.paintLine([{ width: 1 }, { width: 1, background: "#89d1dc" }], 0);

    expect(target.fills.find((call) => call.color === "#89d1dc")).toEqual({
      x: 7,
      y: 0,
      width: 7,
      height: 15,
      color: "#89d1dc",
    });
  });

  test("one rendered row reads metrics and transform once instead of once per cell", () => {
    const transform = { a: 1.25, b: 0, c: 0, d: 1.25, e: 0, f: 0 };
    const target = fixture(transform);
    installGhosttyBackgroundPixelAlignment(target.renderer);

    target.paintLine(
      Array.from({ length: 240 }, () => ({ width: 1, background: "#89d1dc" })),
      0,
    );

    expect(target.fills.filter((call) => call.color === "#89d1dc")).toHaveLength(240);
    expect(target.metricReads).toBe(1);
    expect(target.transformReads).toBe(1);
  });

  test("disposal restores both Ghostty and Canvas methods", () => {
    const transform = { a: 1.25, b: 0, c: 0, d: 1.25, e: 0, f: 0 };
    const target = fixture(transform);
    const dispose = installGhosttyBackgroundPixelAlignment(target.renderer);

    expect(target.context.fillRect).not.toBe(target.originalFillRect);
    expect(target.rawRenderer.renderLine).not.toBe(target.originalRenderLine);
    dispose();

    expect(target.context.fillRect).toBe(target.originalFillRect);
    expect(target.rawRenderer.renderLine).toBe(target.originalRenderLine);
    target.paintLine([{ width: 1 }, { width: 1, background: "#89d1dc" }], 0);
    expect(target.fills.find((call) => call.color === "#89d1dc")?.x).toBe(7);
  });

  test("a rejected renderer patch does not leave Canvas wrapped", () => {
    const transform = { a: 1.25, b: 0, c: 0, d: 1.25, e: 0, f: 0 };
    const target = fixture(transform);
    Object.defineProperty(target.rawRenderer, "renderLine", {
      configurable: true,
      value: target.originalRenderLine,
      writable: false,
    });

    const dispose = installGhosttyBackgroundPixelAlignment(target.renderer);

    expect(target.context.fillRect).toBe(target.originalFillRect);
    expect(target.rawRenderer.renderLine).toBe(target.originalRenderLine);
    expect(dispose).not.toThrow();
  });

  test("missing or inaccessible renderer is a safe no-op", () => {
    expect(() => installGhosttyBackgroundPixelAlignment(undefined)()).not.toThrow();
    const renderer = {
      getCanvas: () => {
        throw new Error("context unavailable");
      },
      getMetrics: () => ({ width: 7, height: 15 }),
      renderLine() {},
    } as unknown as CanvasRenderer;
    expect(() => installGhosttyBackgroundPixelAlignment(renderer)()).not.toThrow();
  });
});

describe("installGhosttySelectionAutoScrollBoundary", () => {
  test("stops auto-scroll while the pointer remains inside the canvas", () => {
    const originalCalls: Array<[number, number]> = [];
    let stopped = 0;
    const manager = {
      stopAutoScroll() {
        stopped += 1;
      },
      updateAutoScroll(offsetY: number, viewportHeight: number) {
        originalCalls.push([offsetY, viewportHeight]);
      },
    };
    const dispose = installGhosttySelectionAutoScrollBoundary({ selectionManager: manager });

    manager.updateAutoScroll(456, 480);
    manager.updateAutoScroll(0, 480);
    manager.updateAutoScroll(480, 480);

    expect(stopped).toBe(3);
    expect(originalCalls).toEqual([]);
    dispose();
  });

  test("preserves Ghostty auto-scroll after the pointer leaves the canvas", () => {
    const originalCalls: Array<[number, number]> = [];
    const manager = {
      stopAutoScroll() {},
      updateAutoScroll(offsetY: number, viewportHeight: number) {
        originalCalls.push([offsetY, viewportHeight]);
      },
    };
    installGhosttySelectionAutoScrollBoundary({ selectionManager: manager });

    manager.updateAutoScroll(-1, 480);
    manager.updateAutoScroll(481, 480);
    manager.updateAutoScroll(Number.NaN, 480);

    expect(originalCalls).toEqual([
      [-1, 480],
      [481, 480],
      [Number.NaN, 480],
    ]);
  });

  test("disposal restores only the installed instance wrapper", () => {
    const original = () => {};
    const manager = { stopAutoScroll() {}, updateAutoScroll: original };
    const dispose = installGhosttySelectionAutoScrollBoundary({ selectionManager: manager });
    expect(manager.updateAutoScroll).not.toBe(original);

    dispose();
    expect(manager.updateAutoScroll).toBe(original);

    const disposeAgain = installGhosttySelectionAutoScrollBoundary({ selectionManager: manager });
    const replacement = () => {};
    manager.updateAutoScroll = replacement;
    disposeAgain();
    expect(manager.updateAutoScroll).toBe(replacement);
  });

  test("missing or locked selection internals are a safe no-op", () => {
    expect(() => installGhosttySelectionAutoScrollBoundary(undefined)()).not.toThrow();
    expect(() => installGhosttySelectionAutoScrollBoundary({})()).not.toThrow();

    const manager = { stopAutoScroll() {}, updateAutoScroll() {} };
    Object.defineProperty(manager, "updateAutoScroll", { writable: false });
    expect(() =>
      installGhosttySelectionAutoScrollBoundary({ selectionManager: manager })(),
    ).not.toThrow();
  });
});
