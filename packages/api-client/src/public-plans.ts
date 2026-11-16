import { z } from "zod";

export const publicPlanPriceSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  cpu: z.number().int().positive(),
  memoryMb: z.number().int().positive(),
  diskGb: z.number().int().positive(),
  gpuType: z.string().nullable(),
  gpuCount: z.number().int().nonnegative(),
  region: z.string().nullable(),
  monthlyPriceCents: z.number().int().nonnegative(),
  annualPriceCents: z.number().int().nonnegative(),
  monthlyPlatformPriceCents: z.number().int().nonnegative(),
  annualPlatformPriceCents: z.number().int().nonnegative(),
});

export const publicPlanCatalogSchema = z.object({
  available: z.boolean(),
  pricingContext: z.enum(["platform", "referral"]),
  billingPeriods: z.array(z.enum(["monthly", "annual"])).min(1),
  plans: z.array(publicPlanPriceSchema),
});

export type PublicPlanPrice = z.infer<typeof publicPlanPriceSchema>;
export type PublicPlanCatalog = z.infer<typeof publicPlanCatalogSchema>;
