import { describe, expect, test } from "bun:test";

import {
  machinePurchasePath,
  machinePurchaseReturnPath,
  parseMachinePurchaseSelection,
} from "./purchase-navigation";

describe("machine purchase navigation", () => {
  test("构造并解析唯一的配置和付费周期", () => {
    expect(machinePurchasePath("Pro 专业版", "annual")).toBe(
      "/machines/new?planCode=Pro+%E4%B8%93%E4%B8%9A%E7%89%88&billingPeriod=annual",
    );
    expect(parseMachinePurchaseSelection("planCode=Base&billingPeriod=monthly")).toEqual({
      planCode: "Base",
      billingPeriod: "monthly",
    });
    expect(machinePurchaseReturnPath("/machines/new?billingPeriod=annual&planCode=Pro")).toBe(
      "/machines/new?planCode=Pro&billingPeriod=annual",
    );
  });

  test("拒绝外部地址、额外或重复参数、Hash 和非法值", () => {
    for (const candidate of [
      "//evil.example/machines/new?planCode=Pro&billingPeriod=annual",
      "/machines/new?planCode=Pro&billingPeriod=annual&next=%2Fadmin",
      "/machines/new?planCode=Pro&planCode=Base&billingPeriod=annual",
      "/machines/new?planCode=Pro&billingPeriod=weekly",
      "/machines/new?planCode=%0APro&billingPeriod=monthly",
      "/machines/new?planCode=Pro&billingPeriod=monthly#token",
      "/machines",
    ]) {
      expect(machinePurchaseReturnPath(candidate)).toBeNull();
    }
    expect(() => machinePurchasePath("\n", "monthly")).toThrow(RangeError);
  });
});
