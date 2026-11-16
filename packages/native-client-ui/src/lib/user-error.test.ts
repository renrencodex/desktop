import { describe, expect, test } from "bun:test";

import { ApiError } from "@cloud-machine/api-client";

import { userErrorMessage } from "./user-error";

const ACTIONABLE_BUSINESS_ERRORS = {
  REFERRAL_PROGRAM_UNAVAILABLE: "当前账号未开通推广功能",
  REFERRAL_PROGRAM_DISABLED: "推广功能已停用，请刷新页面查看最新状态",
  INVALID_REFERRAL_DOMAIN: "域名前缀须为 6–32 位小写英文、数字或短横线，首尾不能为短横线",
  REFERRAL_DOMAIN_RESERVED: "该域名已被占用，请修改",
  REFERRAL_DOMAIN_TAKEN: "该域名已被占用，请修改",
  PLAN_NOT_PURCHASABLE: "所选套餐当前不可购买，请刷新后重新选择",
  TRIAL_UNAVAILABLE: "试用活动暂不可用，你可以稍后再试，或选择付费购买。",
  TRIAL_NOT_ELIGIBLE: "当前账号暂无可用试用资格，你仍可选择付费购买。",
  TRIAL_ELIGIBILITY_EXPIRED: "试用资格已过期，你仍可选择付费购买。",
  TRIAL_CAMPAIGN_PAUSED: "试用活动暂时暂停，你可以稍后再试，或选择付费购买。",
  TRIAL_DAILY_CAPACITY_REACHED: "今天的试用名额已领完，你可以明天再试，或选择付费购买。",
  TRIAL_CAPACITY_REACHED: "试用名额暂时已满，你可以稍后再试，或选择付费购买。",
  TRIAL_PLAN_UNAVAILABLE: "当前规格暂不支持试用，请选择其他试用规格，或付费购买。",
  TRIAL_ALREADY_USED: "试用资格已经领取，请刷新页面查看电脑状态。",
  TRIAL_AUTO_RENEW_UNAVAILABLE: "试用期间暂不能开启自动续费，转为付费后即可设置。",
  CHECKOUT_DISABLED: "当前交易服务暂未开放，请稍后再试",
  MACHINE_CREATION_DISABLED: "购机服务暂未开放，请稍后再试",
  ORDER_REQUIRED: "请先完成购机订单支付",
  INVALID_SSH_KEYS: "所选 SSH 密钥已失效，请刷新后重新选择",
  IMAGE_MANIFEST_UNAVAILABLE: "操作系统列表暂不可用，请稍后重试",
  IMAGE_NOT_AVAILABLE: "所选操作系统已不可用，请刷新后重新选择",
  IMAGE_PLAN_INCOMPATIBLE: "所选操作系统与当前规格不兼容，请重新选择",
  NETWORK_MAINTENANCE: "电脑网络正在维护，请稍后重试",
  INVALID_EGRESS_LINE: "所选网络线路已不可用，请刷新后重新选择",
  EGRESS_UNAVAILABLE: "网络线路服务暂不可用，请稍后重试",
  EGRESS_UPDATE_FAILED: "上次网络线路切换未完成，请重新操作",
  EGRESS_UPDATE_IN_PROGRESS: "网络线路正在切换，请稍后再试",
  SUBSCRIPTION_INACTIVE: "电脑已欠费，请先完成续费",
  SUBSCRIPTION_NOT_RENEWABLE: "当前电脑暂不可续费，请刷新状态后再试",
  SUBSCRIPTION_NOT_ACTIVE: "电脑开通完成后才能续费",
  SUBSCRIPTION_TERMINATED: "电脑订阅已终止",
  PROVISIONING_REFUND_PENDING: "本次创建失败，退款正在处理，请稍后刷新",
  PROVISIONING_REFUNDED: "本次创建订单已全额退款，请删除失败电脑后重新购买",
  PROVISIONING_RETRY_UNAVAILABLE: "当前电脑无法自动恢复，请联系客服处理",
  ORDER_NOT_FOUND: "订单不存在或已失效，请刷新订单列表",
  ORDER_NOT_PAYABLE: "订单当前状态无法支付，请刷新后查看最新状态",
  ORDER_EXPIRED: "订单已过期，请取消后重新创建",
  ORDER_NOT_CLOSABLE: "订单当前状态无法取消，请刷新后查看最新状态",
  ORDER_ALREADY_PAID: "订单已支付，请刷新查看最新状态",
  INSUFFICIENT_BALANCE: "账户余额不足，请充值后再试",
  PAYMENT_METHOD_NOT_ALLOWED: "当前订单不支持所选支付方式，请改用其他方式",
  PAYMENT_AMOUNT_MISMATCH: "订单金额已变化，请刷新后重新确认",
  PAYMENT_ATTEMPT_CLOSED: "本次支付已关闭，请重新打开支付窗口后再试",
  PAYMENT_SCENE_CONFLICT: "订单已在其他设备发起微信支付，请继续原支付或取消订单后重试",
  PAYMENT_SCENE_REQUIRED: "当前微信支付环境无效，请重新打开支付窗口后再试",
  PAYMENT_ORDER_MISMATCH: "支付信息与订单不一致，请关闭支付窗口并刷新订单",
  PAYMENT_RESULT_INCOMPLETE: "支付结果暂未确认，请稍后刷新订单状态",
  WECHAT_PAY_UNAVAILABLE: "微信支付暂不可用，请稍后再试",
  WECHAT_PREPAY_FAILED: "微信支付发起失败，请稍后再试",
} as const;

describe("本地客户端错误中文化", () => {
  test("试用、购机、支付和推广业务错误均给出可行动提示", () => {
    for (const [code, expected] of Object.entries(ACTIONABLE_BUSINESS_ERRORS)) {
      const fallback = "操作失败，请重试";
      const message = userErrorMessage(new ApiError(409, code, "internal detail"), fallback);
      expect(message).toBe(expected);
      expect(message).not.toBe(fallback);
    }
  });
});
