import { describe, expect, test } from "bun:test";
import { captureFileScrollPosition, resolveFileScrollPosition } from "./file-scroll-position";

describe("file scroll position", () => {
  test("内容刷新后保留普通阅读位置", () => {
    const position = captureFileScrollPosition({
      scrollTop: 1_200,
      scrollLeft: 24,
      scrollHeight: 4_000,
      clientHeight: 600,
    });

    expect(position.bottomOffset).toBeNull();
    expect(resolveFileScrollPosition(position, { scrollHeight: 5_000, clientHeight: 600 })).toEqual(
      { top: 1_200, left: 24 },
    );
  });

  test("原来位于底部时，内容追加后继续贴底", () => {
    const position = captureFileScrollPosition({
      scrollTop: 3_400,
      scrollLeft: 0,
      scrollHeight: 4_000,
      clientHeight: 600,
    });

    expect(position.bottomOffset).toBe(0);
    expect(resolveFileScrollPosition(position, { scrollHeight: 5_000, clientHeight: 600 })).toEqual(
      { top: 4_400, left: 0 },
    );
  });

  test("接近底部时保留与底部的距离，短内容不误判为贴底", () => {
    const nearBottom = captureFileScrollPosition({
      scrollTop: 3_390,
      scrollLeft: 0,
      scrollHeight: 4_000,
      clientHeight: 600,
    });
    expect(nearBottom.bottomOffset).toBe(10);
    expect(
      resolveFileScrollPosition(nearBottom, { scrollHeight: 5_000, clientHeight: 600 }),
    ).toEqual({ top: 4_390, left: 0 });

    expect(
      captureFileScrollPosition({
        scrollTop: 0,
        scrollLeft: 0,
        scrollHeight: 500,
        clientHeight: 600,
      }).bottomOffset,
    ).toBeNull();
  });
});
