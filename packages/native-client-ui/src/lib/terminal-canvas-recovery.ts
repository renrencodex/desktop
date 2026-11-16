/** A restored canvas can retain its bitmap size but lose Ghostty's DPR transform. */
export function repairTerminalCanvas(
  canvas: HTMLCanvasElement,
  columns: number,
  cellWidth: number,
  redraw: () => void,
  force = false,
): boolean {
  if (columns <= 0 || cellWidth <= 0) return false;
  const context = canvas.getContext("2d");
  if (!context || context.isContextLost?.()) return false;
  const expectedScale = canvas.width / (columns * cellWidth);
  if (!Number.isFinite(expectedScale) || expectedScale <= 0) return false;
  const transform = context.getTransform();
  if (
    !force &&
    Math.abs(transform.a - expectedScale) < 0.05 &&
    Math.abs(transform.d - expectedScale) < 0.05 &&
    Math.abs(transform.b) < 0.05 &&
    Math.abs(transform.c) < 0.05 &&
    Math.abs(transform.e) < 0.05 &&
    Math.abs(transform.f) < 0.05
  )
    return false;
  redraw();
  return true;
}
