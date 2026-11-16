export const FILE_SCROLL_BOTTOM_THRESHOLD_PX = 16;

export interface FileScrollMetrics {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface FileScrollPosition {
  top: number;
  left: number;
  /** 保留接近底部时的距离；null 表示按绝对位置恢复。 */
  bottomOffset: number | null;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * 记录文件阅读区域的位置。接近底部时改用相对底部的距离，内容追加后仍能贴底。
 */
export function captureFileScrollPosition(
  metrics: FileScrollMetrics,
  bottomThreshold = FILE_SCROLL_BOTTOM_THRESHOLD_PX,
): FileScrollPosition {
  const top = nonNegative(metrics.scrollTop);
  const scrollableHeight = Math.max(
    0,
    nonNegative(metrics.scrollHeight) - nonNegative(metrics.clientHeight),
  );
  const distanceFromBottom = Math.max(0, scrollableHeight - top);
  return {
    top,
    left: nonNegative(metrics.scrollLeft),
    bottomOffset:
      scrollableHeight > 0 && distanceFromBottom <= nonNegative(bottomThreshold)
        ? distanceFromBottom
        : null,
  };
}

/** 根据刷新后的内容高度，计算应恢复到的位置。 */
export function resolveFileScrollPosition(
  position: FileScrollPosition,
  metrics: Pick<FileScrollMetrics, "scrollHeight" | "clientHeight">,
): Pick<FileScrollPosition, "top" | "left"> {
  if (position.bottomOffset === null) return { top: position.top, left: position.left };
  const scrollableHeight = Math.max(
    0,
    nonNegative(metrics.scrollHeight) - nonNegative(metrics.clientHeight),
  );
  return {
    top: Math.max(0, scrollableHeight - position.bottomOffset),
    left: position.left,
  };
}
