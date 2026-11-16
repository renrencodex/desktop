import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import type { ApiClient } from "@cloud-machine/api-client";
import {
  BANK_ACCOUNT_CONSENT_VERSION,
  saveBankAccountSchema,
} from "@cloud-machine/client-contracts";

/** 两端共用表单；完整账户只存在于当前表单内，不放进查询缓存或持久化存储。 */
export function ReferralBankAccount({ api }: { api: ApiClient }) {
  const client = useQueryClient();
  const account = useQuery({
    queryKey: ["referrals", "bank-account"],
    queryFn: () => api.account.referrals.bankAccount(),
  });
  const [mode, setMode] = useState<"save" | "disable" | null>(null);
  const [fields, setFields] = useState({
    recipientName: "",
    cardNumber: "",
    bankName: "",
    currentPassword: "",
  });
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [version, setVersion] = useState(0);
  const key = useRef(crypto.randomUUID());
  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "disable")
        return api.account.referrals.disableBankAccount(
          { currentPassword: fields.currentPassword, expectedVersion: version },
          key.current,
        );
      const parsed = saveBankAccountSchema.safeParse({
        recipientName: fields.recipientName,
        cardNumber: fields.cardNumber,
        bankName: fields.bankName,
        currentPassword: fields.currentPassword,
        expectedVersion: version,
        consentVersion: BANK_ACCOUNT_CONSENT_VERSION,
        ownDebitCard: true,
      });
      if (!parsed.success || !consent)
        throw new Error(
          "请填写收款人姓名、银行名称、16–19 位卡号，并确认本人借记卡及信息处理说明。",
        );
      return api.account.referrals.saveBankAccount(parsed.data, key.current);
    },
    onSuccess: () => {
      setFields({
        recipientName: "",
        cardNumber: "",
        bankName: "",
        currentPassword: "",
      });
      setConsent(false);
      setMode(null);
      setError("");
      setMessage("收款信息已更新");
      key.current = crypto.randomUUID();
      void client.invalidateQueries({ queryKey: ["referrals", "bank-account"] });
    },
    onError: (e: Error) => setError(e.message || "收款信息保存失败，请重试"),
  });
  function open(next: typeof mode) {
    if (mutation.isPending) return;
    setMode(next);
    setError("");
    setMessage("");
    setConsent(false);
    setFields({
      recipientName: "",
      cardNumber: "",
      bankName: "",
      currentPassword: "",
    });
    setVersion(account.data?.account?.version ?? 0);
    key.current = crypto.randomUUID();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!mutation.isPending) {
      setError("");
      mutation.mutate();
    }
  }
  const saved = account.data?.account;
  return (
    <section className="cm-panel p-4 sm:p-5" aria-label="银行卡收款">
      <h3 className="text-xs font-medium text-zinc-200">银行卡收款</h3>
      <p className="mt-2 text-xs leading-5 text-zinc-500">
        佣金按月结算，由平台统一线下打款，无需申请提现。仅支持本人大陆借记卡。
      </p>
      {account.isPending ? (
        <p className="mt-3 text-xs">正在读取收款信息…</p>
      ) : account.isError ? (
        <div className="mt-3 text-xs text-red-400">
          收款信息加载失败{" "}
          <button className="cm-button h-7 px-2" onClick={() => void account.refetch()}>
            重试
          </button>
        </div>
      ) : (
        <>
          <p className="mt-3 text-xs text-zinc-300">
            {saved?.active
              ? [saved.bankName, `尾号 ${saved.cardLast4}`, saved.recipientNameMasked]
                  .filter(Boolean)
                  .join(" · ")
              : "尚未设置有效收款银行卡"}
          </p>
          {account.data?.hasPendingPayout && (
            <p className="mt-2 text-xs leading-5 text-amber-400">
              已有预留打款。换卡或停用不会改变原打款单：已处理款项继续使用旧账户，尚未处理款项需管理员取消重建。
            </p>
          )}
          {!account.data?.enabled ? (
            <p className="mt-2 text-xs text-zinc-500">银行卡维护暂未开放。</p>
          ) : (
            !mode && (
              <div className="mt-3 flex gap-2">
                <button className="cm-button-primary h-8 px-3 text-xs" onClick={() => open("save")}>
                  {saved?.active ? "更换银行卡" : "填写收款信息"}
                </button>
                {saved?.active && (
                  <button className="cm-button h-8 px-3 text-xs" onClick={() => open("disable")}>
                    停用银行卡
                  </button>
                )}
              </div>
            )
          )}
        </>
      )}
      {mode && (
        <form className="mt-4 max-w-lg space-y-3" onSubmit={submit} autoComplete="off">
          <fieldset disabled={mutation.isPending} className="space-y-3">
            {mode === "save" && (
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["recipientName", "收款人姓名", 64],
                    ["bankName", "银行名称", 100],
                    ["cardNumber", "银行卡号", 23],
                  ] as const
                ).map(([field, label, maxLength]) => (
                  <label
                    key={field}
                    className={`block text-xs text-zinc-400 ${field === "cardNumber" ? "sm:col-span-2" : ""}`}
                  >
                    {label}
                    <input
                      className="cm-input mt-1 w-full text-xs"
                      name={field}
                      required
                      maxLength={maxLength}
                      inputMode={field === "cardNumber" ? "numeric" : "text"}
                      value={fields[field]}
                      onChange={(e) => {
                        setFields({ ...fields, [field]: e.target.value });
                        key.current = crypto.randomUUID();
                      }}
                    />
                  </label>
                ))}
              </div>
            )}
            <label className="block max-w-xs text-xs text-zinc-400">
              当前登录密码
              <input
                className="cm-input mt-1 w-full text-xs"
                type="password"
                autoComplete="current-password"
                required
                maxLength={256}
                value={fields.currentPassword}
                onChange={(e) => setFields({ ...fields, currentPassword: e.target.value })}
              />
            </label>
            {mode === "save" && (
              <label className="flex items-start gap-2 text-xs leading-5 text-zinc-500">
                <input
                  className="mt-1"
                  type="checkbox"
                  required
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  我确认这是本人大陆借记卡，并单独同意平台加密保存姓名和收款信息，仅供佣金结算、财务打款及必要核对使用，授权财务在打款时查看或导出资料，历史打款记录按必要期限保留。
                </span>
              </label>
            )}
            {mode === "disable" && (
              <p className="text-xs text-amber-400">
                停用后不再生成新的银行卡打款，已有处理中的付款仍使用原账户。
              </p>
            )}
            <div className="flex gap-2">
              <button className="cm-button-primary h-8 px-3 text-xs" disabled={mutation.isPending}>
                {mutation.isPending ? "处理中…" : mode === "save" ? "保存收款信息" : "确认停用"}
              </button>
              <button
                type="button"
                className="cm-button h-8 px-3 text-xs"
                onClick={() => open(null)}
              >
                取消
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-3 text-xs text-emerald-400">
          {message}
        </p>
      )}
    </section>
  );
}
