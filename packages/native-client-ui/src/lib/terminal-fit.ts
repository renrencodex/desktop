import { PHONE_MEDIA_QUERY } from "./responsive";

export interface TerminalCellMetrics {
  width: number;
  height: number;
}

export interface TerminalGridSize {
  cols: number;
  rows: number;
}

const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;

function parsePx(style: CSSStyleDeclaration, property: string): number {
  const value = Number.parseFloat(style.getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
}

function borderBoxWidth(element: HTMLElement, style: CSSStyleDeclaration): number {
  const width = parsePx(style, "width");
  if (width <= 0) return element.offsetWidth;
  return style.boxSizing === "border-box"
    ? width
    : width +
        parsePx(style, "padding-left") +
        parsePx(style, "padding-right") +
        parsePx(style, "border-left-width") +
        parsePx(style, "border-right-width");
}

/** Content box inside padding. Scrollbars are overlay-drawn and must not shrink the grid. */
export function contentBoxSize(
  element: HTMLElement,
): { width: number; height: number } | undefined {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) return undefined;
  const width =
    element.clientWidth - parsePx(style, "padding-left") - parsePx(style, "padding-right");
  const height =
    element.clientHeight - parsePx(style, "padding-top") - parsePx(style, "padding-bottom");
  if (width <= 0 || height <= 0) return undefined;
  const window = element.ownerDocument.defaultView;
  // 桌面多 Pane 允许在外层滚动，不能按屏幕裁掉其保留的最小网格。
  if (!window?.matchMedia?.(PHONE_MEDIA_QUERY).matches) return { width, height };
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || element.offsetWidth <= 0) return undefined;
  const scaleX = rect.width / borderBoxWidth(element, style);
  const left = rect.left + (element.clientLeft + parsePx(style, "padding-left")) * scaleX;
  let right = Math.min(
    left + width * scaleX,
    rect.right - (parsePx(style, "border-right-width") + parsePx(style, "padding-right")) * scaleX,
    element.ownerDocument.documentElement.clientWidth,
  );
  // 只在未捏合放大时适配 visualViewport，缩放手势不应触发远端终端重排。
  const viewport = window.visualViewport;
  if (viewport && Math.abs(viewport.scale - 1) < 0.01)
    right = Math.min(right, viewport.offsetLeft + viewport.width);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const parentStyle = window.getComputedStyle(parent);
    if (!/^(hidden|clip|auto|scroll)$/.test(parentStyle.overflowX)) continue;
    const bounds = parent.getBoundingClientRect();
    if (parent.offsetWidth <= 0) continue;
    const parentScale = bounds.width / borderBoxWidth(parent, parentStyle);
    right = Math.min(right, bounds.left + (parent.clientLeft + parent.clientWidth) * parentScale);
  }
  const visibleWidth = Math.min(width, (right - left) / scaleX);
  if (visibleWidth <= 0) return undefined;
  return { width: visibleWidth, height };
}

export function terminalGridSize(
  content: { width: number; height: number },
  cell: TerminalCellMetrics,
): TerminalGridSize | undefined {
  if (!(cell.width > 0) || !(cell.height > 0) || content.width <= 0 || content.height <= 0)
    return undefined;
  return {
    cols: Math.max(MINIMUM_COLS, Math.floor(content.width / cell.width)),
    rows: Math.max(MINIMUM_ROWS, Math.floor(content.height / cell.height)),
  };
}

export function applyTerminalGridFit(
  element: HTMLElement | undefined,
  cell: TerminalCellMetrics | undefined,
  current: TerminalGridSize,
  resize: (cols: number, rows: number) => void,
): boolean {
  if (!element || !cell) return false;
  const content = contentBoxSize(element);
  if (!content) return false;
  const next = terminalGridSize(content, cell);
  if (!next) return false;
  if (next.cols !== current.cols || next.rows !== current.rows) resize(next.cols, next.rows);
  return true;
}
