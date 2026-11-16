import { describe, expect, test } from "bun:test";

import { createIsolatedPreviewId, previewBoundsForRect } from "./isolated-preview";

test("每个预览实例生成独立且可用于 Native label 的不透明 id", () => {
  const first = createIsolatedPreviewId();
  const second = createIsolatedPreviewId();
  expect(first).not.toBe(second);
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(second).toMatch(/^[0-9a-f-]{36}$/);
});

describe("previewBoundsForRect", () => {
  test("保留视口内的逻辑像素坐标", () => {
    expect(
      previewBoundsForRect(
        { left: 20, top: 80, right: 1020, bottom: 680 },
        { width: 1280, height: 800 },
      ),
    ).toEqual({ x: 20, y: 80, width: 1000, height: 600 });
  });

  test("裁剪越界区域并拒绝不可见或非有限坐标", () => {
    expect(
      previewBoundsForRect(
        { left: -20, top: 60, right: 1400, bottom: 900 },
        { width: 1280, height: 800 },
      ),
    ).toEqual({ x: 0, y: 60, width: 1280, height: 740 });
    expect(
      previewBoundsForRect(
        { left: 1300, top: 60, right: 1400, bottom: 100 },
        { width: 1280, height: 800 },
      ),
    ).toBeNull();
    expect(
      previewBoundsForRect(
        { left: Number.NaN, top: 0, right: 100, bottom: 100 },
        { width: 1280, height: 800 },
      ),
    ).toBeNull();
  });
});
