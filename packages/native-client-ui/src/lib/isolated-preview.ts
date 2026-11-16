import type { PreviewWebviewBounds } from "@cloud-machine/platform-api";

/** Native labels are process-global; use an opaque per-component id instead of persisted tab ids. */
export function createIsolatedPreviewId(): string {
  return crypto.randomUUID();
}

/** 将 DOM 逻辑像素坐标裁剪到主 WebView 视口，供原生子 WebView 定位。 */
export function previewBoundsForRect(
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
  viewport: { width: number; height: number },
): PreviewWebviewBounds | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewport.width, rect.right);
  const bottom = Math.min(viewport.height, rect.bottom);
  if (![left, top, right, bottom].every(Number.isFinite) || right - left < 1 || bottom - top < 1) {
    return null;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
