import type { CanvasRenderer } from "ghostty-web";

interface GhosttyRendererInternals {
  getCanvas(): HTMLCanvasElement;
  getMetrics(): { width: number; height: number };
  renderLine(line: unknown[], row: number, columns: number): void;
}

interface LinePaintState {
  metrics: { width: number; height: number };
  row: number;
  transform: DOMMatrix;
}

const noop = () => {};
const AXIS_EPSILON = 1e-7;
const GRID_EPSILON = 1e-7;

function isNearInteger(value: number): boolean {
  return Math.abs(value - Math.round(value)) <= GRID_EPSILON;
}

function isCellBackgroundRectangle(
  state: LinePaintState,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  const { metrics, row } = state;
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    Math.abs(y - row * metrics.height) <= GRID_EPSILON &&
    Math.abs(height - metrics.height) <= GRID_EPSILON &&
    isNearInteger(x / metrics.width) &&
    isNearInteger(width / metrics.width)
  );
}

/**
 * ghostty-web 0.4.0 paints selection, ANSI and inverse backgrounds as separate
 * Canvas rectangles for every cell. Fractional DPRs can leave a darker seam
 * between adjacent rectangles, so snap both instances of a shared logical edge
 * to the same device pixel while a line's cell backgrounds are being painted.
 *
 * renderLine is private in Ghostty's typings. Runtime guards and conditional
 * restoration keep this compatibility shim from breaking terminal startup or
 * overwriting another wrapper when the pinned dependency is eventually updated.
 */
export function installGhosttyBackgroundPixelAlignment(
  renderer: CanvasRenderer | undefined,
): () => void {
  if (!renderer) return noop;
  const internals = renderer as unknown as Partial<GhosttyRendererInternals>;
  const originalRenderLine = internals.renderLine;
  const getMetrics = internals.getMetrics;
  let context: CanvasRenderingContext2D | null | undefined;
  try {
    context = internals.getCanvas?.().getContext("2d");
  } catch {
    return noop;
  }
  const originalFillRect = context?.fillRect;
  if (!originalRenderLine || !getMetrics || !context?.getTransform || !originalFillRect)
    return noop;

  let paintState: LinePaintState | undefined;

  const alignedFillRect = function (
    this: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
  ) {
    const state = paintState;
    if (!state || !isCellBackgroundRectangle(state, x, y, width, height)) {
      originalFillRect.call(this, x, y, width, height);
      return;
    }

    const { transform } = state;
    const leftDevice = Math.round(x * transform.a + transform.e);
    const rightDevice = Math.round((x + width) * transform.a + transform.e);
    const topDevice = Math.round(y * transform.d + transform.f);
    const bottomDevice = Math.round((y + height) * transform.d + transform.f);
    const left = (leftDevice - transform.e) / transform.a;
    const top = (topDevice - transform.f) / transform.d;
    const alignedWidth = (rightDevice - leftDevice) / transform.a;
    const alignedHeight = (bottomDevice - topDevice) / transform.d;
    if (!(alignedWidth > 0) || !(alignedHeight > 0)) {
      originalFillRect.call(this, x, y, width, height);
      return;
    }

    originalFillRect.call(this, left, top, alignedWidth, alignedHeight);
  };

  const alignedRenderLine = function (
    this: GhosttyRendererInternals,
    line: unknown[],
    row: number,
    columns: number,
  ) {
    const previous = paintState;
    paintState = undefined;
    try {
      const metrics = getMetrics.call(this);
      const transform = context.getTransform();
      if (
        metrics.width > 0 &&
        metrics.height > 0 &&
        Number.isFinite(transform.a) &&
        Number.isFinite(transform.d) &&
        transform.a > 0 &&
        transform.d > 0 &&
        Number.isFinite(transform.e) &&
        Number.isFinite(transform.f) &&
        Math.abs(transform.b) <= AXIS_EPSILON &&
        Math.abs(transform.c) <= AXIS_EPSILON
      )
        paintState = { metrics, row, transform };
    } catch {
      // The compatibility shim must not block Ghostty's original paint path.
    }

    try {
      originalRenderLine.call(this, line, row, columns);
    } finally {
      paintState = previous;
    }
  };

  const restore = () => {
    try {
      if (context.fillRect === alignedFillRect) context.fillRect = originalFillRect;
    } catch {
      // A locked Canvas method cannot be ours if its replacement was rejected.
    }
    try {
      if (internals.renderLine === alignedRenderLine) internals.renderLine = originalRenderLine;
    } catch {
      // A replaced or locked renderer method belongs to its current owner.
    }
  };

  try {
    context.fillRect = alignedFillRect;
    internals.renderLine = alignedRenderLine;
  } catch {
    restore();
    return noop;
  }
  if (context.fillRect !== alignedFillRect || internals.renderLine !== alignedRenderLine) {
    restore();
    return noop;
  }
  return restore;
}
