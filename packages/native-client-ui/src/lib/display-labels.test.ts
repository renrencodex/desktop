import { describe, expect, test } from "bun:test";

import { peakBandwidthLabel, planLabel } from "./display-labels";

describe("Desktop 套餐中文标签", () => {
  test("新标准名称和升级前旧名称均映射为中文层级", () => {
    expect(planLabel("Nano")).toBe("基础版");
    expect(planLabel("入门版", { code: "Nano", cpu: 2, memoryMb: 2048, diskGb: 50 })).toBe(
      "入门版",
    );
    expect(planLabel("Base")).toBe("基础版");
    expect(planLabel("Standard")).toBe("标准版");
    expect(planLabel("Pro")).toBe("专业版");
    expect(planLabel("Dev Nano")).toBe("基础版");
    expect(planLabel("Dev Standard")).toBe("标准版");
    expect(planLabel("Dev Pro")).toBe("专业版");
    expect(planLabel("高级版")).toBe("专业版");
  });

  test("峰值网速兼容限速、不限速和旧服务端", () => {
    expect(peakBandwidthLabel(20)).toBe("峰值网速20Mbps");
    expect(peakBandwidthLabel(null)).toBe("峰值网速不限速");
    expect(peakBandwidthLabel(undefined)).toBeUndefined();
  });
});
