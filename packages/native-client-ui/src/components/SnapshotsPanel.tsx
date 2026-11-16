/**
 * Snapshots 页签（设计文档 Snapshot 章节；Phase 6 切片 2）。
 *
 * - 数据面：REST api.snapshots.*；存在 creating 备份时 2.5s 轮询直到就绪；
 * - 创建：running/stopped 创建期间均进入 snapshotting；运行中备份保持开机，
 *   Workspace/Terminal/Preview 继续可用；同名重复创建幂等返回；每台电脑最多保留 5 个有效备份；
 * - 列表不展示底层快照存储占用，避免将写时复制增量误解为完整备份大小；
 * - Restore：需备份 available 且电脑 stopped；备份可重复恢复；
 *   强确认对话框明确告知"恢复会用备份覆盖当前系统盘，之后的更改将丢失"；
 * - Delete：确认后异步入队；creating 中禁用；
 * - restore 成功后同时失效 ["machine", machineId]：电脑进入 restoring 过渡态，
 *   由 MachineDetailPage 的 3s 轮询收尾（stopped / error）。
 *
 * 错误处理与样式沿用其他电脑详情面板，不引新依赖。
 */
import type { Machine, MachineSnapshot } from "@cloud-machine/api-client";
import { MAX_MACHINE_SNAPSHOTS } from "@cloud-machine/client-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { canCreateSnapshot, restoreBlockReason } from "../lib/snapshot-utils";
import { userErrorMessage } from "../lib/user-error";
import { toastError, toastSuccess } from "../stores/toast";
import { ConfirmDialog } from "./ConfirmDialog";

const STATUS_LABEL: Record<MachineSnapshot["status"], { dot: string; label: string }> = {
  creating: { dot: "bg-amber-400 animate-pulse", label: "创建中" },
  available: { dot: "bg-emerald-400", label: "可用" },
  error: { dot: "bg-red-500", label: "异常" },
};

export function SnapshotsPanel({
  machineId,
  lifecycleStatus,
}: {
  machineId: string;
  lifecycleStatus: Machine["lifecycleStatus"];
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<MachineSnapshot | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MachineSnapshot | null>(null);
  const previousLifecycleStatus = useRef(lifecycleStatus);
  const observedCreatingSnapshots = useRef(new Map<string, string>());
  const deletingSnapshotId = useRef<string | null>(null);
  const completedDeleteNotification = useRef<string | null>(null);

  const snapshotsQuery = useQuery({
    queryKey: ["machine-snapshots", machineId],
    queryFn: () => api.snapshots.list(machineId),
    // creating 等待 processor 回写 available/error；删除等待对应行消失。
    refetchInterval: (query) => {
      const snapshots = query.state.data;
      if (snapshots?.some((snapshot) => snapshot.status === "creating")) {
        return 2500;
      }
      return deletingSnapshotId.current &&
        snapshots?.some((snapshot) => snapshot.id === deletingSnapshotId.current)
        ? 2500
        : false;
    },
  });

  const invalidateSnapshots = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["machine-snapshots", machineId] }),
    [machineId, queryClient],
  );

  const showError = (err: unknown, fallback: string) => {
    const message = userErrorMessage(err, fallback);
    setError(message);
    toastError(message);
  };

  const createMutation = useMutation({
    mutationFn: (snapshotName: string) => api.snapshots.create(machineId, snapshotName),
    onSuccess: (snapshot) => {
      setError(null);
      setName("");
      if (snapshot.status === "creating") {
        observedCreatingSnapshots.current.set(snapshot.id, snapshot.name);
        queryClient.setQueryData<Machine>(["machine", machineId], (current) =>
          current ? { ...current, lifecycleStatus: "snapshotting" } : current,
        );
        void queryClient.invalidateQueries({ queryKey: ["machine", machineId] });
      } else if (snapshot.status === "available") {
        toastSuccess(`备份“${snapshot.name}”创建成功`);
      }
      queryClient.setQueryData<MachineSnapshot[]>(["machine-snapshots", machineId], (current) => {
        if (!current) return [snapshot];
        const exists = current.some((item) => item.id === snapshot.id);
        return exists
          ? current.map((item) => (item.id === snapshot.id ? snapshot : item))
          : [snapshot, ...current];
      });
      void invalidateSnapshots();
    },
    onError: (err) => showError(err, "创建备份失败，请重试"),
  });

  const restoreMutation = useMutation({
    mutationFn: (snapshot: MachineSnapshot) => api.snapshots.restore(machineId, snapshot.id),
    onMutate: () => {
      setError(null);
      setRestoreTarget(null);
    },
    onSuccess: () => {
      setError(null);
      queryClient.setQueryData<Machine>(["machine", machineId], (current) =>
        current ? { ...current, lifecycleStatus: "restoring" } : current,
      );
      void invalidateSnapshots();
      // 电脑进入 restoring 过渡态：触发详情页 3s 轮询。
      void queryClient.invalidateQueries({ queryKey: ["machine", machineId] });
    },
    onError: (err) => {
      setRestoreTarget(null);
      showError(err, "恢复失败，请重试");
    },
  });

  useEffect(() => {
    const previous = previousLifecycleStatus.current;
    previousLifecycleStatus.current = lifecycleStatus;
    if (previous !== "restoring") return;

    if (lifecycleStatus === "stopped") {
      // 终态到达时重读备份列表和电脑状态。
      void invalidateSnapshots();
      toastSuccess(
        restoreMutation.variables
          ? `备份“${restoreMutation.variables.name}”恢复成功`
          : "备份恢复成功",
      );
    } else if (lifecycleStatus === "error") {
      const message = "备份恢复失败，请查看电脑状态后重试";
      toastError(message);
    }
  }, [invalidateSnapshots, lifecycleStatus, restoreMutation.variables]);

  useEffect(() => {
    if (!snapshotsQuery.data) return;
    const currentSnapshots = new Map(
      snapshotsQuery.data.map((snapshot) => [snapshot.id, snapshot] as const),
    );

    for (const snapshot of snapshotsQuery.data) {
      if (snapshot.status === "creating") {
        observedCreatingSnapshots.current.set(snapshot.id, snapshot.name);
      }
    }

    for (const [snapshotId, snapshotName] of observedCreatingSnapshots.current) {
      const snapshot = currentSnapshots.get(snapshotId);
      if (snapshot?.status === "available") {
        toastSuccess(`备份“${snapshotName}”创建成功`);
        observedCreatingSnapshots.current.delete(snapshotId);
      } else if (snapshot?.status === "error") {
        toastError(`备份“${snapshotName}”创建失败，请重试`);
        observedCreatingSnapshots.current.delete(snapshotId);
      }
    }
  }, [snapshotsQuery.data]);

  const deleteMutation = useMutation({
    mutationFn: (snapshot: MachineSnapshot) => api.snapshots.delete(machineId, snapshot.id),
    onMutate: (snapshot) => {
      setError(null);
      setDeleteTarget(null);
      deletingSnapshotId.current = snapshot.id;
      completedDeleteNotification.current = null;
    },
    onSuccess: () => {
      setError(null);
      void invalidateSnapshots();
    },
    onError: (err) => {
      setDeleteTarget(null);
      deletingSnapshotId.current = null;
      showError(err, "删除备份失败，请重试");
    },
  });

  useEffect(() => {
    const snapshot = deleteMutation.variables;
    if (!deleteMutation.isSuccess || !snapshot || !snapshotsQuery.data) return;
    if (snapshotsQuery.data.some((item) => item.id === snapshot.id)) return;
    if (completedDeleteNotification.current === snapshot.id) return;

    completedDeleteNotification.current = snapshot.id;
    deletingSnapshotId.current = null;
    toastSuccess(`备份“${snapshot.name}”删除成功`);
  }, [deleteMutation.isSuccess, deleteMutation.variables, snapshotsQuery.data]);

  const snapshots = snapshotsQuery.data ?? [];
  const trimmedName = name.trim();
  const activeSnapshotCount = snapshots.filter((snapshot) => snapshot.status !== "error").length;
  const snapshotLimitReached = activeSnapshotCount >= MAX_MACHINE_SNAPSHOTS;
  const creatingSnapshot = snapshots.find((snapshot) => snapshot.status === "creating");
  const createInProgress = createMutation.isPending || creatingSnapshot !== undefined;
  const deletingSnapshot = deleteMutation.variables;
  const deleteInProgress =
    deleteMutation.isPending ||
    (deleteMutation.isSuccess &&
      deletingSnapshot !== undefined &&
      snapshots.some((snapshot) => snapshot.id === deletingSnapshot.id));
  const restoreInProgress = restoreMutation.isPending || lifecycleStatus === "restoring";
  const snapshotOperationInProgress = createInProgress || deleteInProgress || restoreInProgress;
  const createDisabledReason = createInProgress
    ? "备份创建中，请稍候"
    : deleteInProgress
      ? "备份删除中，暂不可创建备份"
      : restoreInProgress
        ? "备份恢复中，暂不可创建备份"
        : snapshotLimitReached
          ? `每台电脑最多保留 ${MAX_MACHINE_SNAPSHOTS} 个备份`
          : !canCreateSnapshot(lifecycleStatus)
            ? "仅运行中或已停止的电脑可创建备份"
            : null;
  const operationProgress = restoreInProgress
    ? {
        label: restoreMutation.isPending
          ? "正在提交备份恢复任务…"
          : restoreMutation.variables
            ? `正在从备份“${restoreMutation.variables.name}”恢复系统盘…`
            : "正在恢复系统盘…",
        note: "电脑将保持关机",
        ariaLabel: "备份恢复进度",
        ariaValueText: "恢复中",
      }
    : deleteInProgress
      ? {
          label: deleteMutation.isPending
            ? "正在提交备份删除任务…"
            : `正在删除备份“${deletingSnapshot?.name ?? ""}”…`,
          note: "删除后不可恢复",
          ariaLabel: "备份删除进度",
          ariaValueText: "删除中",
        }
      : createInProgress
        ? {
            label: createMutation.isPending
              ? "正在提交备份创建任务…"
              : `正在创建备份“${creatingSnapshot?.name ?? createMutation.data?.name ?? ""}”…`,
            note: "完成后即可用于恢复",
            ariaLabel: "备份创建进度",
            ariaValueText: "创建中",
          }
        : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部说明 + 新建备份 */}
      <div className="cm-toolbar h-auto min-h-8 flex-wrap gap-x-4 gap-y-1 px-3 py-1.5">
        <p className="text-[11px] text-zinc-500 sm:text-xs">
          运行中可创建且不中断服务，停止后可恢复，最多保留 {MAX_MACHINE_SNAPSHOTS} 个备份
        </p>
        <form
          className="ml-auto flex w-full items-center gap-2 sm:w-auto"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmedName && !createDisabledReason && !createMutation.isPending) {
              createMutation.mutate(trimmedName);
            }
          }}
        >
          <input
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
            disabled={snapshotOperationInProgress || snapshotLimitReached}
            maxLength={64}
            placeholder="备份名称"
            className="cm-input cm-mobile-compact-input h-8 min-w-0 flex-1 text-xs sm:h-7 sm:w-48 sm:flex-none"
          />
          <button
            type="submit"
            disabled={!trimmedName || !!createDisabledReason || createMutation.isPending}
            title={createDisabledReason ?? undefined}
            className="cm-button-primary"
          >
            {createInProgress ? "创建中…" : "创建备份"}
          </button>
        </form>
      </div>

      {error && <p className="border-b px-4 py-1.5 text-xs cm-banner-danger">{error}</p>}

      {operationProgress && (
        <div role="status" className="shrink-0 border-b border-zinc-800 bg-zinc-900/70 px-4 py-2.5">
          <div className="mb-2 flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate text-zinc-300">{operationProgress.label}</span>
            <span className="shrink-0 text-[10px] text-zinc-500">{operationProgress.note}</span>
          </div>
          <div
            role="progressbar"
            aria-label={operationProgress.ariaLabel}
            aria-valuetext={operationProgress.ariaValueText}
            className="h-1 overflow-hidden rounded-full bg-zinc-800"
          >
            <span className="cm-progress-indeterminate block h-full rounded-full bg-[var(--cm-accent)]" />
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {snapshotsQuery.isPending ? null : snapshotsQuery.isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-xs text-zinc-500 sm:text-sm">
            <p>备份列表加载失败</p>
            <button
              type="button"
              onClick={() => void snapshotsQuery.refetch()}
              className="cm-button"
            >
              重试
            </button>
          </div>
        ) : snapshots.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-xs text-zinc-500 sm:text-sm">
            还没有备份。创建第一个备份以保存当前系统盘状态
          </div>
        ) : (
          <>
            <div className="divide-y divide-zinc-800 lg:hidden" aria-label="备份列表">
              {snapshots.map((snapshot) => {
                const status = STATUS_LABEL[snapshot.status];
                const blockReason = restoreBlockReason(lifecycleStatus, snapshot.status);
                return (
                  <article key={snapshot.id} className="space-y-3 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-zinc-200 sm:text-base">
                          {snapshot.name}
                        </p>
                        <p className="mt-1 text-[10px] text-zinc-500">
                          {new Date(snapshot.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-400 sm:text-xs">
                        <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                        {status.label}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={blockReason !== null || snapshotOperationInProgress}
                        title={blockReason ?? "用该备份覆盖当前系统盘"}
                        onClick={() => setRestoreTarget(snapshot)}
                        className="cm-button-warning"
                      >
                        恢复
                      </button>
                      <button
                        type="button"
                        disabled={
                          snapshot.status === "creating" ||
                          deleteMutation.isPending ||
                          snapshotOperationInProgress
                        }
                        onClick={() => setDeleteTarget(snapshot)}
                        className="cm-button-danger"
                      >
                        {deleteInProgress && deletingSnapshot?.id === snapshot.id
                          ? "删除中…"
                          : "删除"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            <table className="hidden w-full min-w-[680px] text-sm lg:table">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                  <th className="px-4 py-2 font-medium">名称</th>
                  <th className="px-4 py-2 font-medium">状态</th>
                  <th className="px-4 py-2 font-medium">创建时间</th>
                  <th className="px-4 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {snapshots.map((s) => {
                  const status = STATUS_LABEL[s.status];
                  const blockReason = restoreBlockReason(lifecycleStatus, s.status);
                  return (
                    <tr key={s.id}>
                      <td className="max-w-56 truncate px-4 py-2 text-zinc-200">{s.name}</td>
                      <td className="px-4 py-2">
                        <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
                          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                          {status.label}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs text-zinc-400">
                        {new Date(s.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={blockReason !== null || snapshotOperationInProgress}
                            title={blockReason ?? "用该备份覆盖当前系统盘"}
                            onClick={() => setRestoreTarget(s)}
                            className="cm-button-warning"
                          >
                            恢复
                          </button>
                          <button
                            type="button"
                            disabled={
                              s.status === "creating" ||
                              deleteMutation.isPending ||
                              snapshotOperationInProgress
                            }
                            title={s.status === "creating" ? "备份创建中，暂不可删除" : undefined}
                            onClick={() => setDeleteTarget(s)}
                            className="cm-button-danger"
                          >
                            {deleteInProgress && deletingSnapshot?.id === s.id ? "删除中…" : "删除"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* Restore 强确认：明确告知覆盖系统盘、之后的更改丢失 */}
      <ConfirmDialog
        open={restoreTarget !== null}
        title="恢复备份"
        body={
          <>
            确定用备份 <span className="font-medium text-zinc-200">{restoreTarget?.name}</span>{" "}
            恢复电脑吗？
            <span className="text-red-400">
              恢复会用备份覆盖当前系统盘，备份创建之后的更改将丢失
            </span>
          </>
        }
        confirmLabel="确认恢复"
        busy={restoreMutation.isPending}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={() => restoreTarget && restoreMutation.mutate(restoreTarget)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除备份"
        body={
          <>
            确定删除备份 <span className="font-medium text-zinc-200">{deleteTarget?.name}</span>{" "}
            吗？删除后<span className="text-red-400">不可恢复</span>
          </>
        }
        confirmLabel="确认删除"
        busy={deleteMutation.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
      />
    </div>
  );
}
