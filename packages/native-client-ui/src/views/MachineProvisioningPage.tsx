"use client";

import {
  isApiError,
  type Machine,
  type MachineDeletionQuote,
  type MachineProvisionStage,
} from "@cloud-machine/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  Circle,
  LoaderCircle,
  RotateCcw,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "../host";
import { useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { MachineDeletionQuoteSummary } from "../components/MachineDeletionQuoteSummary";
import { api } from "../lib/api";
import { applyAcceptedMachineDeletion } from "../lib/machine-list";
import { isNotFoundError, userErrorMessage } from "../lib/user-error";
import { toastError, toastSuccess } from "../stores/toast";

const STEP_LABELS: Record<Exclude<MachineProvisionStage, "agent">, string> = {
  queued: "任务已进入队列",
  tenant_resources: "准备网络与存储",
  instance: "创建电脑实例",
  boot: "启动操作系统",
  workspace: "验证服务能力",
  ready: "电脑可以使用了",
};

export function MachineProvisioningPage({ machineId }: { machineId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const retryKey = useRef(crypto.randomUUID());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletionQuote, setDeletionQuote] = useState<MachineDeletionQuote | null>(null);
  const [deletionQuoteError, setDeletionQuoteError] = useState<string | null>(null);
  const statusQuery = useQuery({
    queryKey: ["machine-provisioning", machineId],
    queryFn: () => api.machines.provisioning(machineId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "ready" || status === "failed" ? false : 1000;
    },
  });

  useEffect(() => {
    const status = statusQuery.data;
    if (status?.ready) {
      queryClient.removeQueries({ queryKey: ["machine", machineId], exact: true });
      void queryClient.invalidateQueries({ queryKey: ["machines"] });
      router.replace(`/machines/${machineId}`);
    }
  }, [machineId, queryClient, router, statusQuery.data]);

  useEffect(() => {
    if (isNotFoundError(statusQuery.error)) router.replace("/machines");
  }, [router, statusQuery.error]);

  const retryMutation = useMutation({
    mutationFn: () => api.machines.retryProvisioning(machineId, retryKey.current),
    onSuccess: (status) => {
      // 已受理的操作有自己的幂等键；若它最终失败，下一次点击应创建一个新操作。
      retryKey.current = crypto.randomUUID();
      queryClient.setQueryData(["machine-provisioning", machineId], status);
      void queryClient.invalidateQueries({ queryKey: ["machines"] });
    },
  });
  const deletionQuoteMutation = useMutation({
    mutationFn: () => api.machines.getDeletionQuote(machineId),
    onSuccess: (quote) => {
      setDeletionQuote(quote);
      setDeletionQuoteError(null);
      setConfirmDelete(true);
    },
    onError: (error) => {
      setDeletionQuote(null);
      setDeletionQuoteError(userErrorMessage(error, "退款金额计算失败，请重试"));
      setConfirmDelete(true);
    },
  });
  const openDeleteConfirmation = () => {
    setConfirmDelete(false);
    setDeletionQuote(null);
    setDeletionQuoteError(null);
    deletionQuoteMutation.mutate();
  };
  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!deletionQuote) throw new Error("删除报价尚未生成");
      return api.machines.delete(machineId, deletionQuote.quoteId);
    },
    onSuccess: (deletedMachine) => {
      setConfirmDelete(false);
      queryClient.setQueryData<Machine[]>(["machines"], (current) =>
        applyAcceptedMachineDeletion(current, deletedMachine),
      );
      toastSuccess(
        deletionQuote && deletionQuote.totalRefundCents > 0
          ? `电脑删除任务已提交，¥${(deletionQuote.totalRefundCents / 100).toFixed(2)} 已退至账户余额`
          : "电脑删除任务已提交",
      );
      void queryClient.invalidateQueries({ queryKey: ["machines"] });
      void queryClient.invalidateQueries({ queryKey: ["wallet"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      router.replace("/machines");
    },
    onError: (error) => {
      if (
        isApiError(error) &&
        (error.code === "REFUND_QUOTE_CHANGED" || error.code === "DELETION_QUOTE_EXPIRED")
      ) {
        setConfirmDelete(false);
        setDeletionQuote(null);
        setDeletionQuoteError(null);
        toastError("退款金额已变化，正在重新获取删除信息");
        deletionQuoteMutation.mutate();
        return;
      }
      setConfirmDelete(false);
      toastError(userErrorMessage(error, "删除电脑失败，请重试"));
    },
  });

  if (statusQuery.isPending || isNotFoundError(statusQuery.error)) {
    return null;
  }
  if (statusQuery.isError) {
    return (
      <ProvisioningMessage
        error
        label={userErrorMessage(statusQuery.error, "创建进度加载失败，请稍后刷新")}
      />
    );
  }

  const status = statusQuery.data;
  const agentStep = status.steps.find((step) => step.key === "agent");
  const failed = status.status === "failed";
  const canRetry = failed && status.recoveryAction === "retry";
  const statusText = failed
    ? "电脑初始化失败"
    : status.status === "retrying"
      ? `正在自动重试（${status.attempt}/${status.maxAttempts}）`
      : status.ready
        ? "电脑已经可以使用"
        : "正在初始化电脑";

  return (
    <div className="flex h-full min-h-0 overflow-auto p-4 sm:p-8">
      <section className="cm-panel m-auto w-full max-w-2xl overflow-hidden [@media(min-height:700px)]:-translate-y-[50px]">
        <header className="border-b border-zinc-800 px-5 py-5 sm:px-7">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-zinc-800 bg-zinc-950 text-zinc-400">
              <Server size={17} />
            </span>
            <div className="min-w-0">
              <h1 className="text-sm font-medium text-zinc-100">{statusText}</h1>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                完成终端与文件能力验证后会自动打开电脑面板，请保持本页面开启
              </p>
            </div>
            <span className="ml-auto text-lg font-medium tabular-nums text-zinc-200">
              {status.progress}%
            </span>
          </div>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${failed ? "bg-red-500" : "bg-[var(--cm-accent)]"}`}
              style={{ width: `${status.progress}%` }}
            />
          </div>
        </header>

        <div className="space-y-1 px-5 py-4 sm:px-7">
          {status.steps.map((step) => {
            if (step.key === "agent") return null;
            const stepStatus =
              step.key === "boot" && step.status === "completed"
                ? (agentStep?.status ?? step.status)
                : step.status;
            return (
              <div key={step.key} className="flex min-h-9 items-center gap-3 text-xs">
                {stepStatus === "completed" ? (
                  <Check size={14} className="text-[var(--cm-accent)]" />
                ) : stepStatus === "failed" ? (
                  <X size={14} className="text-red-400" />
                ) : stepStatus === "active" ? (
                  <LoaderCircle size={14} className="animate-spin text-[var(--cm-accent)]" />
                ) : (
                  <Circle size={11} className="m-[1.5px] text-[var(--cm-accent)] opacity-40" />
                )}
                <span
                  className={
                    stepStatus === "active"
                      ? "text-zinc-200"
                      : stepStatus === "failed"
                        ? "text-red-300"
                        : "text-zinc-500"
                  }
                >
                  {STEP_LABELS[step.key]}
                </span>
              </div>
            );
          })}
        </div>

        {!status.ready && (
          <footer className="border-t border-zinc-800 bg-zinc-950/40 px-5 py-4 sm:px-7">
            {failed && (
              <p className="mb-3 text-xs text-red-300">
                {status.error?.message ?? "电脑创建失败，请重试"}
              </p>
            )}
            {(retryMutation.isError || deleteMutation.isError) && (
              <p className="mb-3 text-xs text-red-400">
                {userErrorMessage(
                  retryMutation.error ?? deleteMutation.error,
                  "操作失败，请稍后重试",
                )}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="cm-button text-red-300"
                disabled={
                  deleteMutation.isPending ||
                  retryMutation.isPending ||
                  deletionQuoteMutation.isPending
                }
                onClick={openDeleteConfirmation}
              >
                {deletionQuoteMutation.isPending ? (
                  <LoaderCircle size={13} className="motion-safe:animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 size={13} />
                )}
                {deleteMutation.isPending
                  ? "正在删除…"
                  : deletionQuoteMutation.isPending
                    ? "正在准备…"
                    : failed
                      ? "删除电脑"
                      : "取消并删除"}
              </button>
              {canRetry && (
                <button
                  type="button"
                  className="cm-button-primary"
                  disabled={retryMutation.isPending || deleteMutation.isPending}
                  onClick={() => retryMutation.mutate()}
                >
                  <RotateCcw size={13} />
                  {retryMutation.isPending ? "正在重试…" : "重新创建"}
                </button>
              )}
            </div>
          </footer>
        )}

        {status.ready && (
          <footer className="flex justify-end border-t border-zinc-800 px-5 py-4 sm:px-7">
            <button
              type="button"
              className="cm-button-primary"
              onClick={() => router.replace(`/machines/${machineId}`)}
            >
              打开电脑面板 <ArrowRight size={13} />
            </button>
          </footer>
        )}
      </section>
      <ConfirmDialog
        open={confirmDelete}
        title={failed ? "删除电脑" : "取消创建并删除电脑"}
        body={
          <>
            确定{failed ? "删除" : "取消创建并删除"}
            这台电脑吗？已创建的虚拟机与磁盘数据将被异步清理，
            <span className="text-red-400">不可恢复</span>
            <MachineDeletionQuoteSummary
              quote={deletionQuote}
              pending={deletionQuoteMutation.isPending}
              error={deletionQuoteError}
            />
          </>
        }
        confirmLabel={failed ? "确认删除" : "确认取消并删除"}
        busy={deleteMutation.isPending}
        confirmDisabled={!deletionQuote || deletionQuoteMutation.isPending}
        onCancel={() => {
          setConfirmDelete(false);
          setDeletionQuote(null);
          setDeletionQuoteError(null);
        }}
        onConfirm={() => deleteMutation.mutate()}
      />
    </div>
  );
}

function ProvisioningMessage({ label, error = false }: { label: string; error?: boolean }) {
  return (
    <div
      className={`flex h-full items-center justify-center text-sm ${error ? "text-red-300" : "text-zinc-500"}`}
    >
      {label}
    </div>
  );
}
