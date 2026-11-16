import type { CanvasRenderer, Terminal } from "ghostty-web";

/**
 * ghostty-web 0.4.0 的画布滚动条会擦掉最后 14px；淡出后底部的非脏行不会补画。
 * 应用层提供统一的 DOM 滚动条，因此所有绘制入口（包括淡出动画）都跳过该覆盖层。
 * 仅包装实例的公开 render 方法，不修改依赖源码或全局原型。
 */
export function suppressGhosttyScrollbar(
  term: Terminal,
  container: HTMLElement,
  isVisible: () => boolean = () => true,
): () => void {
  const renderer = term.renderer;
  if (!renderer) return () => {};
  const originalRender = renderer.render;
  // 固定版本的私有回调仅用于解绑其 DOM 热区；隐藏绘制后不能再劫持正文点击。
  // 升级 Ghostty 时需同时验证右边缘点击和滚动回归。
  const scrollbarMouseDown = (term as unknown as { handleMouseDown?: EventListener })
    .handleMouseDown;
  const render: CanvasRenderer["render"] = (buffer, forceAll, viewportY, provider) => {
    if (!isVisible()) return;
    originalRender.call(renderer, buffer, forceAll, viewportY, provider, 0);
  };
  renderer.render = render;
  if (scrollbarMouseDown) container.removeEventListener("mousedown", scrollbarMouseDown, true);
  if (term.wasmTerm) renderer.render(term.wasmTerm, true, term.getViewportY(), term, 0);
  return () => {
    if (renderer.render === render) renderer.render = originalRender;
    if (scrollbarMouseDown) container.addEventListener("mousedown", scrollbarMouseDown, true);
  };
}
