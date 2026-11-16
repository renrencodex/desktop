"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CLI_STORE_CANCEL_MIN_CONTRACT_VERSION,
  CLI_STORE_MIN_CONTRACT_VERSION,
  type CliAppId,
} from "@cloud-machine/client-contracts";
import { ChevronDown, ChevronUp, ScrollText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { userErrorMessage } from "../lib/user-error";
import { useAuthStore } from "../stores/auth";
import { ConfirmDialog } from "./ConfirmDialog";
import { CliAppIcon } from "./CliAppIcon";
import {
  CLI_STORE_CONNECTION_POLL_INTERVAL_MS,
  cliStoreInventoryPollInterval,
  mergeCliCatalog,
  sortCliAppsByName,
} from "@cloud-machine/workspace-ui";

const INCOMPLETE_INSTALL_MESSAGE = "上次安装未完成，请查看日志后重新安装";
const INCOMPLETE_UNINSTALL_MESSAGE = "上次卸载未完成，重新安装会自动清理旧程序";

export function CliStorePanel({
  machineId,
  available,
  active = true,
}: {
  machineId: string;
  available: boolean;
  active?: boolean;
}) {
  const accountId = useAuthStore((state) => state.user?.id);
  const catalog = useQuery({
    queryKey: ["cli-store-catalog", accountId],
    queryFn: () => api.cliStore.catalog(),
    enabled: active,
    retry: false,
    refetchInterval: active ? 15_000 : false,
  });
  const client = useQueryClient();
  const key = ["cli-store", accountId, machineId];
  const previousConnectionOnlineRef = useRef<boolean | undefined>(undefined);
  const inventory = useQuery({
    queryKey: key,
    queryFn: () => api.cliStore.inventory(machineId),
    retry: false,
    enabled: active,
    refetchInterval: (query) => cliStoreInventoryPollInterval(active, query.state.data?.operation),
  });
  const connection = useQuery({
    queryKey: ["machine-connection", accountId, machineId],
    queryFn: () => api.machines.connection(machineId),
    retry: false,
    enabled: active,
    refetchInterval: active ? CLI_STORE_CONNECTION_POLL_INTERVAL_MS : false,
  });
  const [confirm, setConfirm] = useState<CliAppId | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const operationLogRef = useRef<HTMLPreElement>(null);
  const operationLogFollowing = useRef(true);
  const request = useRef<{ key: string; appId: CliAppId; action: "install" | "uninstall" } | null>(
    null,
  );
  const mutation = useMutation({
    mutationFn: (input: { appId: CliAppId; action: "install" | "uninstall" }) => {
      if (
        !request.current ||
        request.current.appId !== input.appId ||
        request.current.action !== input.action
      )
        request.current = { ...input, key: crypto.randomUUID() };
      return api.cliStore.operate(machineId, input, request.current.key);
    },
    onSuccess: (operation) => {
      request.current = null;
      setConfirm(null);
      setLogOpen(true);
      client.setQueryData(
        key,
        (previous: Awaited<ReturnType<typeof api.cliStore.inventory>> | undefined) =>
          previous ? { ...previous, operation } : previous,
      );
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const cancelMutation = useMutation({
    mutationFn: (operationId: string) => api.cliStore.cancel(machineId, operationId),
    onSuccess: (nextOperation) => {
      setLogOpen(true);
      client.setQueryData(
        key,
        (previous: Awaited<ReturnType<typeof api.cliStore.inventory>> | undefined) =>
          previous ? { ...previous, operation: nextOperation } : previous,
      );
      void client.invalidateQueries({ queryKey: key });
    },
    onError: () => void client.invalidateQueries({ queryKey: key }),
  });
  const apps = sortCliAppsByName(
    mergeCliCatalog(catalog.data ?? [], inventory.data?.installations ?? []),
  );
  const listed = new Set((catalog.data ?? []).map((app) => app.id));
  const operation = inventory.data?.operation;
  const completedLogLine = operation?.cancelled
    ? "安装已取消"
    : operation?.state === "completed"
      ? operation.action === "install"
        ? "安装已完成"
        : "卸载已完成"
      : null;
  const operationOutput = operation
    ? completedLogLine && operation.output.at(-1) !== completedLogLine
      ? [...operation.output, completedLogLine]
      : operation.output
    : [];
  const connectionOnline = connection.data?.online ?? inventory.data?.online;
  const refetchInventory = inventory.refetch;
  useEffect(() => {
    const reconnected =
      active && previousConnectionOnlineRef.current === false && connectionOnline === true;
    previousConnectionOnlineRef.current = connectionOnline;
    if (reconnected) void refetchInventory();
  }, [active, connectionOnline, refetchInventory]);
  useEffect(() => {
    if (!logOpen) return;
    operationLogFollowing.current = true;
    const log = operationLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [logOpen, operation?.operationId]);
  useEffect(() => {
    if (!logOpen || !operationLogFollowing.current) return;
    const log = operationLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [logOpen, operation?.updatedAt]);
  const pending =
    mutation.isPending ||
    (operation !== null &&
      operation !== undefined &&
      ["queued", "running"].includes(operation.state));
  const reachable =
    available && connectionOnline === true && inventory.data?.online === true && !inventory.error;
  const agentCompatible =
    (inventory.data?.agentContractVersion ?? 0) >= CLI_STORE_MIN_CONTRACT_VERSION;
  const cancellationCompatible =
    (inventory.data?.agentContractVersion ?? 0) >= CLI_STORE_CANCEL_MIN_CONTRACT_VERSION;
  const installActionable = reachable && inventory.data?.supported === true;
  const uninstallActionable = reachable && agentCompatible;
  const retryActionable =
    operation?.action === "uninstall" ? uninstallActionable : installActionable;
  const stage = {
    queued: "等待执行",
    checking: "检查环境",
    downloading: "下载安装制品",
    installing: "安装中",
    uninstalling: "卸载中",
    verifying: "验证安装状态",
    completed: "操作完成",
    failed: "操作失败",
  };
  const stageLabel = operation?.cancelled
    ? "安装已取消"
    : operation?.cancelRequested && ["queued", "running"].includes(operation.state)
      ? "正在取消安装"
      : operation
        ? stage[operation.stage]
        : "";
  return (
    <section id="cli-store" className="cm-panel mt-3 p-3" aria-label="CLI Store">
      <h2 className="text-sm font-medium">CLI Store</h2>
      <p className="mt-1 text-xs text-zinc-500">
        将CLI应用安装到这台电脑里，在工作区的“应用”页启动。
      </p>
      {!available && (
        <p role="status" className="mt-2 text-xs text-zinc-500">
          启动电脑并连接后可以安装或卸载。当前显示最近确认状态。
        </p>
      )}
      {available && connectionOnline === false && !connection.isPending && (
        <p role="status" className="mt-2 text-xs text-zinc-500">
          电脑通信暂时中断，恢复连接后可以安装或卸载。当前显示最近确认状态。
        </p>
      )}
      {available && inventory.data && !inventory.data.supported && (
        <p role="status" className="mt-2 text-xs text-amber-500">
          {agentCompatible
            ? "当前电脑暂不支持安装新应用；已由 CLI Store 管理的应用仍可卸载。"
            : "请升级电脑通信服务后安装或卸载应用。"}
        </p>
      )}
      {catalog.error && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          应用目录查询失败{" "}
          <button className="cm-button" onClick={() => void catalog.refetch()}>
            重试目录
          </button>
        </p>
      )}
      {!catalog.isPending && !catalog.error && !apps.length && (
        <p className="mt-2 text-xs text-zinc-500">暂无上架应用。</p>
      )}
      {inventory.error && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {userErrorMessage(inventory.error, "安装状态查询失败")}{" "}
          <button className="cm-button" onClick={() => void inventory.refetch()}>
            重试查询
          </button>
        </p>
      )}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
        {apps.map((app) => {
          const installed = inventory.data?.installations.find((item) => item.appId === app.id);
          const installingNow =
            (mutation.isPending &&
              mutation.variables?.appId === app.id &&
              mutation.variables.action === "install") ||
            (operation?.appId === app.id &&
              operation.action === "install" &&
              ["queued", "running"].includes(operation.state));
          const installationError =
            installingNow &&
            [INCOMPLETE_INSTALL_MESSAGE, INCOMPLETE_UNINSTALL_MESSAGE].includes(
              installed?.error ?? "",
            )
              ? null
              : installed?.error;
          return (
            <article key={app.id} className="rounded border border-zinc-800 p-3">
              <div className="flex items-center gap-3">
                <CliAppIcon appId={app.id} icon={app.icon} />
                <div>
                  <h3 className="text-xs font-medium">{app.name}</h3>
                  <span className="text-[10px] text-zinc-500">
                    {installed?.installed ? (installed.version ?? "需要检查") : "未安装"}
                  </span>
                </div>
              </div>
              <p className="mt-2 min-h-8 text-xs text-zinc-500">
                {app.description}
                {!listed.has(app.id) ? " · 已下架" : ""}
              </p>
              {installationError && (
                <p className="mb-2 text-xs text-red-400">{installationError}</p>
              )}
              {!installed?.installed && installed?.installSupported === false && (
                <p className="mb-2 text-xs text-amber-500">请升级电脑通信服务后安装此应用。</p>
              )}
              {installed?.installed && !installed.managed ? (
                <p className="text-xs text-zinc-500">手动安装 · 请通过原安装方式卸载</p>
              ) : (
                <div className="flex gap-2">
                  <button
                    className="cm-button-primary"
                    disabled={
                      !installActionable ||
                      installed?.installSupported === false ||
                      pending ||
                      installed?.installed ||
                      !listed.has(app.id) ||
                      !!catalog.error
                    }
                    onClick={() => mutation.mutate({ appId: app.id, action: "install" })}
                    aria-label={`安装 ${app.name}`}
                  >
                    安装
                  </button>
                  <button
                    className="cm-button"
                    disabled={!uninstallActionable || pending || !installed?.managed}
                    onClick={() => setConfirm(app.id)}
                    aria-label={`卸载 ${app.name}`}
                  >
                    卸载
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {mutation.error && (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {userErrorMessage(mutation.error, "应用操作提交失败，请重试")}
        </p>
      )}
      {cancelMutation.error && (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {userErrorMessage(cancelMutation.error, "取消安装失败，请稍后重试")}
        </p>
      )}
      {operation && (
        <div className="mt-3 text-xs" role="status">
          <span>
            {apps.find((app) => app.id === operation.appId)?.name ?? operation.appId} · {stageLabel}
          </span>
          {operation.error && <p className="mt-1 text-red-400">{operation.error}</p>}
          <button
            type="button"
            className={`cm-icon-button ml-1 gap-0.5 align-middle ${logOpen ? "text-[var(--cm-accent)]" : ""}`}
            aria-label={logOpen ? "收起安装日志" : "查看安装日志"}
            aria-expanded={logOpen}
            aria-controls="cli-store-operation-log"
            title={logOpen ? "收起安装日志" : "查看安装日志"}
            onClick={() => setLogOpen(!logOpen)}
          >
            {logOpen ? (
              <ChevronUp aria-hidden="true" size={9} />
            ) : (
              <ChevronDown aria-hidden="true" size={9} />
            )}
            <ScrollText aria-hidden="true" size={11} />
          </button>
          {operation.action === "install" &&
            ["queued", "running"].includes(operation.state) &&
            cancellationCompatible && (
              <button
                type="button"
                className="cm-button ml-2"
                disabled={cancelMutation.isPending || operation.cancelRequested}
                onClick={() => cancelMutation.mutate(operation.operationId)}
              >
                {cancelMutation.isPending || operation.cancelRequested ? "正在取消…" : "取消安装"}
              </button>
            )}
          {operation.state === "failed" && !operation.cancelled && (
            <button
              className="cm-button ml-2"
              disabled={!retryActionable || mutation.isPending}
              onClick={() => mutation.mutate({ appId: operation.appId, action: operation.action })}
            >
              重试
            </button>
          )}
          {logOpen && (
            <pre
              id="cli-store-operation-log"
              ref={operationLogRef}
              aria-label="安装日志"
              className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 font-mono text-[11px]"
              onScroll={(event) => {
                const log = event.currentTarget;
                operationLogFollowing.current =
                  log.scrollHeight - log.scrollTop - log.clientHeight <= 16;
              }}
            >
              {operationOutput.join("\n") || "等待任务输出…"}
            </pre>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title="卸载应用"
        body="卸载只会删除应用本身，登录信息、使用记录和项目文件都会保留。如果应用已经打开，请先关闭它。"
        confirmLabel="卸载"
        busy={mutation.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) mutation.mutate({ appId: confirm, action: "uninstall" });
        }}
      />
    </section>
  );
}
