const WORD_SEPARATORS = /[\s()[\]{}'"`]/u;
const EDGE_SCROLL_SIZE_PX = 24;
const EDGE_SCROLL_INTERVAL_MS = 90;
const HANDLE_HIT_RADIUS_PX = 28;
const PHONE_MEDIA_QUERY = "(max-width: 639px)";
const MAGNIFIER_WIDTH_PX = 132;
const MAGNIFIER_HEIGHT_PX = 72;
const MAGNIFIER_SCALE = 2;
const MAGNIFIER_EDGE_GAP_PX = 8;
const MAGNIFIER_FINGER_GAP_PX = 56;

export interface TerminalSelectionCell {
  getChars(): string;
  getWidth(): number;
}

export interface TerminalSelectionLine {
  readonly length: number;
  readonly isWrapped: boolean;
  getCell(column: number): TerminalSelectionCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface TerminalSelectionBuffer {
  readonly cols: number;
  readonly rows: number;
  getViewportTop(): number;
  getBufferLength(): number;
  getLine(row: number): TerminalSelectionLine | undefined;
  /** Normalize renderer-specific wrap flags to "this row continues into the next row". */
  wrapsToNext(row: number): boolean;
  getSurface(): HTMLElement | null;
  scrollLines(lines: number): boolean;
}

export interface TerminalSelectionPoint {
  column: number;
  row: number;
}

export interface TerminalSelectionRange {
  start: TerminalSelectionPoint;
  end: TerminalSelectionPoint;
}

export interface TerminalMagnifierLayout {
  left: number;
  top: number;
  placement: "above" | "below";
}

export interface TerminalSelectionMagnifierStyle {
  background?: string;
  foreground?: string;
  fontFamily?: () => string;
}

export function terminalMagnifierLayout(
  container: Pick<DOMRect, "width" | "height" | "left" | "top">,
  point: { x: number; y: number },
): TerminalMagnifierLayout {
  const localX = point.x - container.left;
  const localY = point.y - container.top;
  const maxLeft = Math.max(
    MAGNIFIER_EDGE_GAP_PX,
    container.width - MAGNIFIER_WIDTH_PX - MAGNIFIER_EDGE_GAP_PX,
  );
  const left = Math.max(MAGNIFIER_EDGE_GAP_PX, Math.min(localX - MAGNIFIER_WIDTH_PX / 2, maxLeft));
  return {
    left,
    top: Math.max(MAGNIFIER_EDGE_GAP_PX, localY - MAGNIFIER_HEIGHT_PX - MAGNIFIER_FINGER_GAP_PX),
    placement: "above",
  };
}

function comparePoints(a: TerminalSelectionPoint, b: TerminalSelectionPoint): number {
  return a.row === b.row ? a.column - b.column : a.row - b.row;
}

export function normalizeTerminalSelection(range: TerminalSelectionRange): TerminalSelectionRange {
  return comparePoints(range.start, range.end) <= 0
    ? range
    : { start: range.end, end: range.start };
}

function selectableColumn(line: TerminalSelectionLine, column: number): number {
  let current = Math.max(0, Math.min(column, Math.max(0, line.length - 1)));
  while (current > 0 && line.getCell(current)?.getWidth() === 0) current--;
  return current;
}

function isWordCell(line: TerminalSelectionLine, column: number): boolean {
  const cell = line.getCell(column);
  if (!cell) return false;
  if (cell.getWidth() === 0) return column > 0 && isWordCell(line, column - 1);
  const chars = cell.getChars();
  return chars.length > 0 && !WORD_SEPARATORS.test(chars);
}

export function terminalWordRange(
  line: TerminalSelectionLine,
  point: TerminalSelectionPoint,
): TerminalSelectionRange | null {
  const column = selectableColumn(line, point.column);
  const cell = line.getCell(column);
  if (!cell?.getChars() || /^\s+$/u.test(cell.getChars())) return null;
  if (!isWordCell(line, column)) {
    return {
      start: { row: point.row, column },
      end: { row: point.row, column: Math.min(line.length - 1, column + cell.getWidth() - 1) },
    };
  }

  let start = column;
  let end = column;
  while (start > 0 && isWordCell(line, start - 1)) start--;
  while (end + 1 < line.length && isWordCell(line, end + 1)) end++;
  while (end + 1 < line.length && line.getCell(end + 1)?.getWidth() === 0) end++;
  return { start: { row: point.row, column: start }, end: { row: point.row, column: end } };
}

export function terminalSelectionText(
  buffer: Pick<TerminalSelectionBuffer, "cols" | "getLine"> &
    Partial<Pick<TerminalSelectionBuffer, "wrapsToNext">>,
  range: TerminalSelectionRange,
): string {
  const normalized = normalizeTerminalSelection(range);
  const parts: string[] = [];
  for (let row = normalized.start.row; row <= normalized.end.row; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const start =
      row === normalized.start.row ? selectableColumn(line, normalized.start.column) : 0;
    const end = row === normalized.end.row ? normalized.end.column + 1 : buffer.cols;
    let text = "";
    for (let column = start; column < end; column++) {
      const cell = line.getCell(column);
      if (!cell || cell.getWidth() === 0) continue;
      text += cell.getChars() || " ";
    }
    parts.push(text.trimEnd());
    // xterm 把标记记在续行，Ghostty 把标记记在被续写的行；适配层统一语义。
    const wrapsToNext = buffer.wrapsToNext?.(row) ?? buffer.getLine(row + 1)?.isWrapped === true;
    if (row < normalized.end.row && !wrapsToNext) parts.push("\n");
  }
  return parts.join("");
}

export interface TerminalTouchSelection {
  begin(point: { x: number; y: number }): boolean;
  beginHandleDrag(point: { x: number; y: number }): boolean;
  beginRange(point: { x: number; y: number }): boolean;
  armRangeSelection(): void;
  update(point: { x: number; y: number }): void;
  end(): void;
  clear(): void;
  refresh(): void;
  hasSelection(): boolean;
  getSelection(): string;
  isActive(): boolean;
  isRangeSelectionArmed(): boolean;
  getActionAnchor(): { x: number; y: number } | null;
  onChange(listener: () => void): { dispose(): void };
  dispose(): void;
}

/** Canvas terminals have no DOM text selection, so render and own a touch-only range overlay. */
export function createTerminalTouchSelection(
  container: HTMLElement,
  buffer: TerminalSelectionBuffer,
  selectionBackground: string,
  magnifierStyle: TerminalSelectionMagnifierStyle = {},
): TerminalTouchSelection {
  const view = container.ownerDocument.defaultView;
  const overlay = container.ownerDocument.createElement("div");
  overlay.className = "cm-terminal-selection-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.setProperty("--cm-terminal-selection-bg", selectionBackground);
  const magnifier = container.ownerDocument.createElement("div");
  magnifier.className = "cm-terminal-selection-magnifier";
  magnifier.dataset.terminalSelectionMagnifier = "";
  magnifier.setAttribute("aria-hidden", "true");
  magnifier.hidden = true;
  magnifier.style.width = `${MAGNIFIER_WIDTH_PX}px`;
  magnifier.style.height = `${MAGNIFIER_HEIGHT_PX}px`;
  magnifier.style.setProperty("--cm-terminal-magnifier-bg", magnifierStyle.background ?? "#141414");
  magnifier.style.setProperty("--cm-terminal-magnifier-target", selectionBackground);
  const magnifierCanvas = container.ownerDocument.createElement("canvas");
  magnifierCanvas.className = "cm-terminal-selection-magnifier-canvas";
  const magnifierTarget = container.ownerDocument.createElement("span");
  magnifierTarget.className = "cm-terminal-selection-magnifier-target";
  magnifier.append(magnifierCanvas, magnifierTarget);
  container.append(overlay, magnifier);

  const listeners = new Set<() => void>();
  let anchor: TerminalSelectionRange | null = null;
  let range: TerminalSelectionRange | null = null;
  let rangeSelectionArmed = false;
  let lastPoint: { x: number; y: number } | null = null;
  let draggingHandle: "start" | "end" | null = null;
  let edgeTimer = 0;
  let edgeDirection = 0;
  let renderFrame = 0;
  let magnifierPoint: { x: number; y: number } | null = null;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const locate = (point: { x: number; y: number }): TerminalSelectionPoint | null => {
    const surface = buffer.getSurface();
    if (!surface || buffer.cols < 1 || buffer.rows < 1) return null;
    const rect = surface.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    const x = Math.max(0, Math.min(point.x - rect.left, rect.width - Number.EPSILON));
    const y = Math.max(0, Math.min(point.y - rect.top, rect.height - Number.EPSILON));
    return {
      column: Math.min(buffer.cols - 1, Math.floor((x / rect.width) * buffer.cols)),
      row: Math.min(
        buffer.getBufferLength() - 1,
        buffer.getViewportTop() +
          Math.min(buffer.rows - 1, Math.floor((y / rect.height) * buffer.rows)),
      ),
    };
  };

  const stopEdgeScroll = () => {
    if (edgeTimer && view) view.clearInterval(edgeTimer);
    edgeTimer = 0;
    edgeDirection = 0;
  };

  const renderSelection = () => {
    overlay.replaceChildren();
    if (!range) return;
    const surface = buffer.getSurface();
    if (!surface || buffer.cols < 1 || buffer.rows < 1) return;
    const surfaceRect = surface.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (!(surfaceRect.width > 0) || !(surfaceRect.height > 0)) return;
    const cellWidth = surfaceRect.width / buffer.cols;
    const cellHeight = surfaceRect.height / buffer.rows;
    const viewportTop = buffer.getViewportTop();
    const viewportBottom = viewportTop + buffer.rows - 1;
    const normalized = normalizeTerminalSelection(range);
    const first = Math.max(normalized.start.row, viewportTop);
    const last = Math.min(normalized.end.row, viewportBottom);
    for (let row = first; row <= last; row++) {
      const startColumn = row === normalized.start.row ? normalized.start.column : 0;
      const endColumn = row === normalized.end.row ? normalized.end.column : buffer.cols - 1;
      const rect = container.ownerDocument.createElement("div");
      rect.className = "cm-terminal-selection-row";
      rect.style.left = `${surfaceRect.left - containerRect.left + startColumn * cellWidth}px`;
      rect.style.top = `${surfaceRect.top - containerRect.top + (row - viewportTop) * cellHeight}px`;
      rect.style.width = `${Math.max(cellWidth, (endColumn - startColumn + 1) * cellWidth)}px`;
      rect.style.height = `${cellHeight}px`;
      overlay.append(rect);
    }
    if (!view?.matchMedia?.(PHONE_MEDIA_QUERY).matches) return;
    for (const endpoint of ["start", "end"] as const) {
      const position = normalized[endpoint];
      if (position.row < viewportTop || position.row > viewportBottom) continue;
      const handle = container.ownerDocument.createElement("div");
      handle.className = `cm-terminal-selection-handle cm-terminal-selection-handle-${endpoint}`;
      handle.style.left = `${surfaceRect.left - containerRect.left + Math.max(8, Math.min(surfaceRect.width - 8, (position.column + (endpoint === "end" ? 1 : 0)) * cellWidth))}px`;
      handle.style.top = `${surfaceRect.top - containerRect.top + Math.max(8, Math.min(surfaceRect.height - 8, (position.row - viewportTop + 1) * cellHeight))}px`;
      overlay.append(handle);
    }
  };

  const terminalCanvases = (surface: HTMLElement): HTMLCanvasElement[] => {
    if (surface.tagName === "CANVAS") return [surface as HTMLCanvasElement];
    return [...surface.querySelectorAll<HTMLCanvasElement>("canvas")].filter(
      (candidate) => candidate !== magnifierCanvas,
    );
  };

  const drawMagnifierFallback = (
    context: CanvasRenderingContext2D,
    surfaceRect: DOMRect,
    crop: { left: number; top: number; width: number; height: number },
  ) => {
    const cellWidth = surfaceRect.width / buffer.cols;
    const cellHeight = surfaceRect.height / buffer.rows;
    const scaleX = MAGNIFIER_WIDTH_PX / crop.width;
    const scaleY = MAGNIFIER_HEIGHT_PX / crop.height;
    const viewportTop = buffer.getViewportTop();
    const firstViewportRow = Math.max(0, Math.floor((crop.top - surfaceRect.top) / cellHeight));
    const lastViewportRow = Math.min(
      buffer.rows - 1,
      Math.ceil((crop.top + crop.height - surfaceRect.top) / cellHeight),
    );
    const firstColumn = Math.max(0, Math.floor((crop.left - surfaceRect.left) / cellWidth));
    const lastColumn = Math.min(
      buffer.cols - 1,
      Math.ceil((crop.left + crop.width - surfaceRect.left) / cellWidth),
    );
    context.fillStyle = magnifierStyle.foreground ?? "#ffffff";
    context.font = `${Math.max(12, cellHeight * scaleY * 0.78)}px ${magnifierStyle.fontFamily?.() ?? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"}`;
    context.textBaseline = "middle";
    context.textAlign = "left";
    for (let viewportRow = firstViewportRow; viewportRow <= lastViewportRow; viewportRow++) {
      const line = buffer.getLine(viewportTop + viewportRow);
      if (!line) continue;
      const y = (surfaceRect.top + (viewportRow + 0.5) * cellHeight - crop.top) * scaleY;
      for (let column = firstColumn; column <= lastColumn; column++) {
        const cell = line.getCell(column);
        if (!cell || cell.getWidth() === 0 || !cell.getChars()) continue;
        const x = (surfaceRect.left + column * cellWidth - crop.left) * scaleX;
        context.fillText(cell.getChars(), x, y);
      }
    }
  };

  const renderMagnifier = (point: { x: number; y: number }) => {
    if (!view?.matchMedia?.(PHONE_MEDIA_QUERY).matches) {
      magnifier.hidden = true;
      return;
    }
    const surface = buffer.getSurface();
    if (!surface || buffer.cols < 1 || buffer.rows < 1) {
      magnifier.hidden = true;
      return;
    }
    const surfaceRect = surface.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (
      !(surfaceRect.width > 0) ||
      !(surfaceRect.height > 0) ||
      !(containerRect.width > 0) ||
      !(containerRect.height > 0)
    ) {
      magnifier.hidden = true;
      return;
    }

    const locatedFromPoint = locate(point);
    const located =
      draggingHandle && range
        ? normalizeTerminalSelection(range)[draggingHandle]
        : locatedFromPoint;
    if (!located) {
      magnifier.hidden = true;
      return;
    }
    const line = buffer.getLine(located.row);
    const column = line ? selectableColumn(line, located.column) : located.column;
    const cellSpan = Math.max(1, line?.getCell(column)?.getWidth() ?? 1);
    const cellWidth = surfaceRect.width / buffer.cols;
    const cellHeight = surfaceRect.height / buffer.rows;
    const viewportRow = located.row - buffer.getViewportTop();
    const targetX = surfaceRect.left + (column + cellSpan / 2) * cellWidth;
    const targetY = surfaceRect.top + (viewportRow + 0.5) * cellHeight;
    const requestedCropWidth = MAGNIFIER_WIDTH_PX / MAGNIFIER_SCALE;
    const requestedCropHeight = MAGNIFIER_HEIGHT_PX / MAGNIFIER_SCALE;
    const cropWidth = Math.min(requestedCropWidth, surfaceRect.width);
    const cropHeight = Math.min(requestedCropHeight, surfaceRect.height);
    const cropLeft = Math.max(
      surfaceRect.left,
      Math.min(targetX - cropWidth / 2, surfaceRect.right - cropWidth),
    );
    const cropTop = Math.max(
      surfaceRect.top,
      Math.min(targetY - cropHeight / 2, surfaceRect.bottom - cropHeight),
    );
    const crop = { left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight };
    const pixelRatio = Math.max(1, Math.min(3, view.devicePixelRatio || 1));
    const canvasWidth = Math.round(MAGNIFIER_WIDTH_PX * pixelRatio);
    const canvasHeight = Math.round(MAGNIFIER_HEIGHT_PX * pixelRatio);
    if (magnifierCanvas.width !== canvasWidth) magnifierCanvas.width = canvasWidth;
    if (magnifierCanvas.height !== canvasHeight) magnifierCanvas.height = canvasHeight;
    const context = magnifierCanvas.getContext("2d");
    if (context) {
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, MAGNIFIER_WIDTH_PX, MAGNIFIER_HEIGHT_PX);
      context.fillStyle = magnifierStyle.background ?? "#141414";
      context.fillRect(0, 0, MAGNIFIER_WIDTH_PX, MAGNIFIER_HEIGHT_PX);
      let paintedCanvas = false;
      for (const source of terminalCanvases(surface)) {
        const sourceRect = source.getBoundingClientRect();
        if (
          !(source.width > 0) ||
          !(source.height > 0) ||
          !(sourceRect.width > 0) ||
          !(sourceRect.height > 0)
        )
          continue;
        const left = Math.max(crop.left, sourceRect.left);
        const top = Math.max(crop.top, sourceRect.top);
        const right = Math.min(crop.left + crop.width, sourceRect.right);
        const bottom = Math.min(crop.top + crop.height, sourceRect.bottom);
        if (right <= left || bottom <= top) continue;
        try {
          context.drawImage(
            source,
            ((left - sourceRect.left) / sourceRect.width) * source.width,
            ((top - sourceRect.top) / sourceRect.height) * source.height,
            ((right - left) / sourceRect.width) * source.width,
            ((bottom - top) / sourceRect.height) * source.height,
            ((left - crop.left) / crop.width) * MAGNIFIER_WIDTH_PX,
            ((top - crop.top) / crop.height) * MAGNIFIER_HEIGHT_PX,
            ((right - left) / crop.width) * MAGNIFIER_WIDTH_PX,
            ((bottom - top) / crop.height) * MAGNIFIER_HEIGHT_PX,
          );
          paintedCanvas = true;
        } catch {
          // A renderer may expose an uncapturable canvas; its buffer remains authoritative.
        }
      }
      if (!paintedCanvas) drawMagnifierFallback(context, surfaceRect, crop);
      magnifier.dataset.source = paintedCanvas ? "canvas" : "buffer";
    }

    const layout = terminalMagnifierLayout(containerRect, point);
    magnifier.style.left = `${layout.left}px`;
    magnifier.style.top = `${layout.top}px`;
    magnifier.dataset.placement = layout.placement;
    magnifier.style.setProperty(
      "--cm-terminal-magnifier-target-x",
      `${((targetX - crop.left) / crop.width) * MAGNIFIER_WIDTH_PX}px`,
    );
    magnifier.style.setProperty(
      "--cm-terminal-magnifier-target-y",
      `${((targetY - crop.top) / crop.height) * MAGNIFIER_HEIGHT_PX}px`,
    );
    magnifier.style.setProperty(
      "--cm-terminal-magnifier-target-width",
      `${Math.max(4, (cellSpan * cellWidth * MAGNIFIER_WIDTH_PX) / crop.width)}px`,
    );
    magnifier.style.setProperty(
      "--cm-terminal-magnifier-target-height",
      `${Math.max(8, (cellHeight * MAGNIFIER_HEIGHT_PX) / crop.height)}px`,
    );
    magnifier.hidden = false;
  };

  const render = () => {
    renderFrame = 0;
    renderSelection();
    if (magnifierPoint) renderMagnifier(magnifierPoint);
    else magnifier.hidden = true;
  };

  const scheduleRender = () => {
    if (!view || renderFrame) return;
    renderFrame = view.requestAnimationFrame(render);
  };

  const flushRender = () => {
    if (renderFrame && view) view.cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    render();
  };

  const handlePoint = (endpoint: "start" | "end"): { x: number; y: number } | null => {
    if (!range) return null;
    const surface = buffer.getSurface();
    if (!surface || buffer.cols < 1 || buffer.rows < 1) return null;
    const position = normalizeTerminalSelection(range)[endpoint];
    const viewportTop = buffer.getViewportTop();
    if (position.row < viewportTop || position.row >= viewportTop + buffer.rows) return null;
    const rect = surface.getBoundingClientRect();
    return {
      x:
        rect.left +
        Math.max(
          8,
          Math.min(
            rect.width - 8,
            (position.column + (endpoint === "end" ? 1 : 0)) * (rect.width / buffer.cols),
          ),
        ),
      y:
        rect.top +
        Math.max(
          8,
          Math.min(rect.height - 8, (position.row - viewportTop + 1) * (rect.height / buffer.rows)),
        ),
    };
  };

  const setRange = (
    next: TerminalSelectionRange | null,
    { notify = true, immediate = true }: { notify?: boolean; immediate?: boolean } = {},
  ) => {
    range = next;
    if (immediate) flushRender();
    else scheduleRender();
    if (notify) emit();
  };

  const updateRange = (point: { x: number; y: number }) => {
    lastPoint = point;
    if (!anchor) return;
    const current = locate(point);
    if (!current) return;
    if (comparePoints(current, anchor.start) < 0)
      setRange({ start: current, end: anchor.end }, { notify: false, immediate: false });
    else if (comparePoints(current, anchor.end) > 0)
      setRange({ start: anchor.start, end: current }, { notify: false, immediate: false });
    else setRange(anchor, { notify: false, immediate: false });
  };

  const updateHandleRange = (point: { x: number; y: number }) => {
    if (!range || !draggingHandle) return;
    const located = locate(point);
    if (!located) return;
    const line = buffer.getLine(located.row);
    if (!line || line.length < 1) return;
    const column = selectableColumn(line, located.column);
    const width = Math.max(1, line.getCell(column)?.getWidth() ?? 1);
    const start = { row: located.row, column };
    const end = { row: located.row, column: Math.min(line.length - 1, column + width - 1) };
    const normalized = normalizeTerminalSelection(range);
    if (draggingHandle === "start") {
      if (comparePoints(start, normalized.end) > 0) {
        setRange({ start: normalized.end, end }, { notify: false, immediate: false });
        draggingHandle = "end";
      } else setRange({ start, end: normalized.end }, { notify: false, immediate: false });
    } else if (comparePoints(end, normalized.start) < 0) {
      setRange({ start, end: normalized.start }, { notify: false, immediate: false });
      draggingHandle = "start";
    } else setRange({ start: normalized.start, end }, { notify: false, immediate: false });
  };

  const updateEdgeScroll = (point: { x: number; y: number }) => {
    if (!view) return;
    const surface = buffer.getSurface();
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const direction =
      point.y < rect.top + EDGE_SCROLL_SIZE_PX
        ? -1
        : point.y > rect.bottom - EDGE_SCROLL_SIZE_PX
          ? 1
          : 0;
    if (direction === edgeDirection) return;
    stopEdgeScroll();
    if (!direction) return;
    edgeDirection = direction;
    edgeTimer = view.setInterval(() => {
      if (!range || !lastPoint || !buffer.scrollLines(edgeDirection)) {
        stopEdgeScroll();
        return;
      }
      if (draggingHandle) updateHandleRange(lastPoint);
      else updateRange(lastPoint);
    }, EDGE_SCROLL_INTERVAL_MS);
  };

  return {
    begin: (point) => {
      stopEdgeScroll();
      const located = locate(point);
      if (!located) return false;
      const line = buffer.getLine(located.row);
      if (!line || line.length < 1) return false;
      const word = terminalWordRange(line, located);
      if (!word) return false;
      anchor = word;
      rangeSelectionArmed = false;
      lastPoint = point;
      magnifierPoint = point;
      setRange(word);
      return true;
    },
    beginRange: (point) => {
      stopEdgeScroll();
      const located = locate(point);
      if (!located) return false;
      const line = buffer.getLine(located.row);
      if (!line || line.length < 1) return false;
      const column = selectableColumn(line, located.column);
      const cellWidth = Math.max(1, line.getCell(column)?.getWidth() ?? 1);
      const cellRange = {
        start: { row: located.row, column },
        end: { row: located.row, column: Math.min(line.length - 1, column + cellWidth - 1) },
      };
      anchor = cellRange;
      rangeSelectionArmed = false;
      lastPoint = point;
      magnifierPoint = point;
      setRange(cellRange);
      return true;
    },
    beginHandleDrag: (point) => {
      if (!range || !view?.matchMedia?.(PHONE_MEDIA_QUERY).matches) return false;
      const candidates = (["start", "end"] as const)
        .map((endpoint) => ({ endpoint, center: handlePoint(endpoint) }))
        .filter(
          (
            candidate,
          ): candidate is { endpoint: "start" | "end"; center: { x: number; y: number } } =>
            candidate.center !== null,
        );
      const nearest = candidates
        .map(({ endpoint, center }) => ({
          endpoint,
          distance: Math.hypot(point.x - center.x, point.y - center.y),
        }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (!nearest || nearest.distance > HANDLE_HIT_RADIUS_PX) return false;
      draggingHandle = nearest.endpoint;
      lastPoint = point;
      magnifierPoint = point;
      flushRender();
      return true;
    },
    armRangeSelection: () => {
      if (!range || rangeSelectionArmed) return;
      rangeSelectionArmed = true;
      emit();
    },
    update: (point) => {
      if (!range) return;
      magnifierPoint = point;
      if (draggingHandle) {
        updateHandleRange(point);
        lastPoint = point;
        updateEdgeScroll(point);
        return;
      }
      updateRange(point);
      updateEdgeScroll(point);
    },
    end: () => {
      draggingHandle = null;
      stopEdgeScroll();
      magnifierPoint = null;
      flushRender();
      if (range) emit();
    },
    clear: () => {
      stopEdgeScroll();
      draggingHandle = null;
      anchor = null;
      lastPoint = null;
      magnifierPoint = null;
      const shouldEmit = range !== null || rangeSelectionArmed;
      rangeSelectionArmed = false;
      range = null;
      flushRender();
      if (shouldEmit) emit();
    },
    refresh: scheduleRender,
    hasSelection: () => Boolean(range && terminalSelectionText(buffer, range).length > 0),
    getSelection: () => (range ? terminalSelectionText(buffer, range) : ""),
    isActive: () => range !== null,
    isRangeSelectionArmed: () => rangeSelectionArmed,
    getActionAnchor: () => lastPoint,
    onChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose: () => {
      stopEdgeScroll();
      if (renderFrame && view) view.cancelAnimationFrame(renderFrame);
      renderFrame = 0;
      listeners.clear();
      overlay.remove();
      magnifier.remove();
      anchor = null;
      range = null;
      rangeSelectionArmed = false;
    },
  };
}
