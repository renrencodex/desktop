import { z } from "zod";

export const BANK_ACCOUNT_CONSENT_VERSION = "bank-payout-v1";
const bankNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
const bankBranchSchema = z
  .string()
  .trim()
  .min(2)
  .max(150)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
export const bankAccountDetailsSchema = z
  .object({
    recipientName: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[^\p{Cc}\p{Cf}]+$/u),
    cardNumber: z
      .string()
      .transform((s) => s.replace(/ /g, ""))
      .pipe(z.string().regex(/^\d{16,19}$/)),
    // 历史密文可能缺少银行名称，或仍携带不再采集的开户支行。
    bankName: bankNameSchema.optional(),
    bankBranch: bankBranchSchema.optional(),
  })
  .strict();
export type BankAccountDetails = z.infer<typeof bankAccountDetailsSchema>;
// 输出不使用卡号转换器，确保响应序列化与 OpenAPI 描述一致。
export const bankAccountViewSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  active: z.boolean(),
  recipientNameMasked: z.string(),
  cardLast4: z.string(),
  bankName: z.string(),
  updatedAt: z.iso.datetime(),
});
export type BankAccountView = z.infer<typeof bankAccountViewSchema>;
export const bankAccountResponseSchema = z.object({
  enabled: z.boolean(),
  account: bankAccountViewSchema.nullable(),
  hasPendingPayout: z.boolean(),
});
export type BankAccountResponse = z.infer<typeof bankAccountResponseSchema>;
export const saveBankAccountSchema = bankAccountDetailsSchema.extend({
  bankName: bankNameSchema,
  currentPassword: z.string().min(1).max(256),
  expectedVersion: z.number().int().nonnegative(),
  consentVersion: z.literal(BANK_ACCOUNT_CONSENT_VERSION),
  ownDebitCard: z.literal(true),
});
export type SaveBankAccountInput = z.infer<typeof saveBankAccountSchema>;
export const disableBankAccountSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const referralPayoutStatusSchema = z.enum([
  "queued",
  "submitting",
  "reconciling",
  "waiting_funds",
  "succeeded",
  "failed",
  "skipped",
  "manual_review",
  "processing",
  "cancelled",
  "returned",
]);
export type ReferralPayoutStatus = z.infer<typeof referralPayoutStatusSchema>;
export const referralPayoutSchema = z.object({
  id: z.string(),
  month: z.string(),
  channel: z.enum(["wechat", "offline_bank"]),
  grossAmountCents: z.number().int().positive(),
  withheldAmountCents: z.number().int().nonnegative(),
  netAmountCents: z.number().int().positive(),
  status: referralPayoutStatusSchema,
  payoutNo: z.string().nullable(),
  cardLast4: z.string().nullable(),
  bankName: z.string().nullable(),
  actualPaidAt: z.iso.datetime().nullable(),
  failureCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export type ReferralPayout = z.infer<typeof referralPayoutSchema>;
