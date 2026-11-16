import type { GroupImperativeHandle, PanelImperativeHandle } from "react-resizable-panels";

export interface ExplorerPanelLayout extends Record<string, number> {
  editor: number;
  tree: number;
}

/** 编辑区 360px + 目录树 220px，再留出拖拽条和少量布局余量。 */
export const EXPLORER_DRAWER_BREAKPOINT_PX = 640;

export function explorerUsesDrawer(containerWidth: number): boolean {
  return containerWidth < EXPLORER_DRAWER_BREAKPOINT_PX;
}

export function explorerPanelLayout(treeSize: number, treeCollapsed: boolean): ExplorerPanelLayout {
  const tree = treeCollapsed ? 0 : treeSize;
  return { editor: 100 - tree, tree };
}

/**
 * react-resizable-panels 需要非零容器尺寸才能解析 px/% 约束。
 * 父标签 display:none 时不能写布局，否则会把目录树留在 0 宽状态。
 * 收起必须走 Panel.collapse()：setLayout({ tree: 0 }) 在 minSize 约束下不可靠。
 */
export function applyExplorerPanelLayoutWhenVisible(
  element: HTMLElement,
  group: GroupImperativeHandle | null,
  layout: ExplorerPanelLayout,
  treePanel?: PanelImperativeHandle | null,
): boolean {
  if (!group || element.offsetWidth <= 0) return false;
  if (layout.tree === 0) {
    if (!treePanel) return false;
    treePanel.collapse();
  } else {
    group.setLayout(layout);
    // 容器可能正在被外层布局压缩，setLayout 此时会保留 tree=0。
    // 只有目录树真正获得宽度才算恢复完成，否则继续等待 ResizeObserver。
    if ((group.getLayout().tree ?? 0) < 1) return false;
  }
  return true;
}

export interface ExplorerPanelRestoreScheduler {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frame: number) => void;
  observe: (element: HTMLElement, callback: () => void) => () => void;
}

/** 隐藏时持续等待，直到容器恢复有效宽度后只应用一次布局。 */
export function scheduleExplorerPanelLayoutRestore(
  element: HTMLElement,
  getGroup: () => GroupImperativeHandle | null,
  layout: ExplorerPanelLayout,
  scheduler: ExplorerPanelRestoreScheduler,
  getTreePanel: () => PanelImperativeHandle | null = () => null,
): () => void {
  let frame: number | null = null;
  let restored = false;
  let disposed = false;
  const restore = () => {
    frame = null;
    if (disposed) return;
    restored = applyExplorerPanelLayoutWhenVisible(element, getGroup(), layout, getTreePanel());
  };
  const schedule = () => {
    if (!disposed && !restored && frame === null) frame = scheduler.requestFrame(restore);
  };
  const stopObserving = scheduler.observe(element, schedule);
  schedule();
  return () => {
    disposed = true;
    stopObserving();
    if (frame !== null) scheduler.cancelFrame(frame);
  };
}
