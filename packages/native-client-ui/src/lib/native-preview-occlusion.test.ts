import { describe, expect, test } from "bun:test";

import {
  createNativePreviewOcclusionStore,
  isNativePreviewOccluded,
  previewRectsOverlap,
} from "./native-preview-occlusion";

describe("native preview occlusion", () => {
  test("only overlapping popups occlude a preview; touching edges and hidden elements do not", () => {
    const preview = { left: 100, top: 80, right: 900, bottom: 700 };
    expect(previewRectsOverlap(preview, { left: 650, top: 50, right: 880, bottom: 300 })).toBe(
      true,
    );
    expect(previewRectsOverlap(preview, { left: 0, top: 0, right: 1000, bottom: 800 })).toBe(true);
    expect(previewRectsOverlap(preview, { left: 0, top: 0, right: 100, bottom: 300 })).toBe(false);
    expect(previewRectsOverlap(preview, { left: 0, top: 0, right: 1000, bottom: 80 })).toBe(false);
    expect(previewRectsOverlap(preview, { left: 200, top: 200, right: 200, bottom: 200 })).toBe(
      false,
    );
    expect(previewRectsOverlap(preview, { left: NaN, top: 80, right: 900, bottom: 700 })).toBe(
      false,
    );
  });

  test("keeps the preview blocked until every overlay closes", () => {
    const store = createNativePreviewOcclusionStore();

    store.getState().setBlocked("theme-menu", true);
    store.getState().setBlocked("dialog", true);
    expect(isNativePreviewOccluded(store)).toBe(true);

    store.getState().setBlocked("theme-menu", false);
    expect(isNativePreviewOccluded(store)).toBe(true);

    store.getState().setBlocked("dialog", false);
    expect(isNativePreviewOccluded(store)).toBe(false);
  });

  test("treats repeated updates as idempotent", () => {
    const store = createNativePreviewOcclusionStore();

    store.getState().setBlocked("menu", true);
    store.getState().setBlocked("menu", true);
    expect(store.getState().blockers).toEqual(new Set(["menu"]));

    store.getState().setBlocked("menu", false);
    store.getState().setBlocked("menu", false);
    expect(store.getState().blockers.size).toBe(0);
  });
});
