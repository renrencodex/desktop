import { describe, expect, test } from "bun:test";

import { publicPlanCatalogSchema } from "./public-plans";

const plan = {
  code: "Pro",
  name: "专业版",
  cpu: 8,
  memoryMb: 16_384,
  diskGb: 200,
  gpuType: null,
  gpuCount: 0,
  region: "中国大陆",
  monthlyPriceCents: 18_000,
  annualPriceCents: 216_000,
  monthlyPlatformPriceCents: 24_000,
  annualPlatformPriceCents: 288_000,
};

describe("public plan catalog contract", () => {
  test("只保留公开套餐字段", () => {
    expect(
      publicPlanCatalogSchema.parse({
        available: true,
        pricingContext: "referral",
        billingPeriods: ["monthly", "annual"],
        plans: [{ ...plan, id: "internal-plan-id", costPriceCents: 10_000 }],
      }),
    ).toEqual({
      available: true,
      pricingContext: "referral",
      billingPeriods: ["monthly", "annual"],
      plans: [plan],
    });
  });

  test("拒绝无效资源和价格", () => {
    expect(
      publicPlanCatalogSchema.safeParse({
        available: true,
        pricingContext: "platform",
        billingPeriods: ["monthly"],
        plans: [{ ...plan, cpu: 0 }],
      }).success,
    ).toBe(false);
    expect(
      publicPlanCatalogSchema.safeParse({
        available: true,
        pricingContext: "platform",
        billingPeriods: ["monthly"],
        plans: [{ ...plan, monthlyPriceCents: -1 }],
      }).success,
    ).toBe(false);
    expect(
      publicPlanCatalogSchema.safeParse({
        available: true,
        pricingContext: "platform",
        billingPeriods: [],
        plans: [plan],
      }).success,
    ).toBe(false);
  });
});
