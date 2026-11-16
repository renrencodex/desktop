/**
 * Ports 页签（设计文档 20 节 Port Preview；Phase 5 切片 E）。
 *
 * - 数据面：REST api.ports.*（list 每 2s 轮询，仅在本页签激活期间挂载）；
 *   电脑离线时 API 返回 503，显示友好空态而非报错；
 * - Open：public 直开 previewUrl；private 带 ?token= 打开（后端 Set-Cookie
 *   并 302 去掉 query，后续资产/WS 走 cookie），统一经桌面平台接口交给系统浏览器；
 *   UDP 端口无 HTTP 预览，Open 禁用；
 * - Share：createShare 生成带 share_token 的链接（可直接打开，无需 access token），
 *   过期时间在顶部统一下拉选择；未过期链接由 API 加载，刷新后仍可复制或撤销。
 *
 * 注意：本组件涉及真实后端的部分未在无浏览器环境实测（见交付报告）。
 */
import {
  isApiError,
  type MachinePort,
  type MachinePortShare,
  type PortVisibility,
} from "@cloud-machine/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { useClientHost } from "../host";
import { api } from "../lib/api";
import { machinePortSharesQueryKey, updateMachinePortSharesCache } from "../lib/port-share-cache";
import {
  buildPreviewOpenUrl,
  canOpenPreview,
  normalizePreviewUrlHostname,
  portsRefetchInterval,
  previewDomainLabel,
  SHARE_EXPIRY_OPTIONS,
} from "../lib/ports-utils";
import { getFreshAccessToken } from "../lib/session";
import { userErrorMessage } from "../lib/user-error";

const VISIBILITY_LABEL: Record<PortVisibility, string> = {
  private: "仅自己",
  public: "公开",
};

export function PortsPanel({ machineId, active = true }: { machineId: string; active?: boolean }) {
  const { platform } = useClientHost();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [expiryIdx, setExpiryIdx] = useState(0); // 默认 1 小时
  const [openingPort, setOpeningPort] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedPreviewUrl, setCopiedPreviewUrl] = useState<string | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const portsQuery = useQuery({
    queryKey: ["machine-ports", machineId],
    queryFn: () => api.ports.list(machineId),
    // 页签激活期间 2s 轮询，及时反映电脑内新监听的端口。
    enabled: active,
    refetchInterval: portsRefetchInterval(active),
  });
  const sharesQuery = useQuery({
    queryKey: machinePortSharesQueryKey(machineId),
    queryFn: () => api.ports.listShares(machineId),
    enabled: active,
  });

  // 电脑离线（agent 不可达）时 API 返回 503：展示友好空态而非错误。
  const offline =
    isApiError(portsQuery.error) && portsQuery.error.status === 503 && !portsQuery.data;

  const invalidatePorts = () =>
    queryClient.invalidateQueries({ queryKey: ["machine-ports", machineId] });

  const refreshPorts = async () => {
    setManualRefreshing(true);
    try {
      await portsQuery.refetch();
    } finally {
      setManualRefreshing(false);
    }
  };

  const showError = (err: unknown, fallback: string) => setError(userErrorMessage(err, fallback));

  const visibilityMutation = useMutation({
    mutationFn: ({ port, visibility }: { port: number; visibility: PortVisibility }) =>
      api.ports.setVisibility(machineId, port, visibility),
    onSuccess: () => {
      setError(null);
      void invalidatePorts();
    },
    onError: (err) => showError(err, "更新可见性失败，请重试"),
  });

  const shareMutation = useMutation({
    mutationFn: (port: number) =>
      api.ports.createShare(machineId, port, {
        expiresInSeconds: SHARE_EXPIRY_OPTIONS[expiryIdx]?.seconds,
      }),
    onSuccess: async (share, port) => {
      setError(null);
      await updateMachinePortSharesCache(queryClient, machineId, (current) => [
        { ...share, port },
        ...current.filter((item) => item.id !== share.id),
      ]);
    },
    onError: (err) => showError(err, "生成分享链接失败，请重试"),
  });

  const revokeMutation = useMutation({
    mutationFn: (share: MachinePortShare) => api.ports.deleteShare(machineId, share.port, share.id),
    onSuccess: async (_data, share) => {
      setError(null);
      await updateMachinePortSharesCache(queryClient, machineId, (current) =>
        current.filter((item) => item.id !== share.id),
      );
    },
    onError: (err) => showError(err, "撤销分享链接失败，请重试"),
  });

  const openPreview = async (p: MachinePort) => {
    setError(null);
    setOpeningPort(p.port);
    try {
      // private 需要新鲜 access token 做首次认证；public 直接打开。
      const token = p.visibility === "public" ? null : await getFreshAccessToken();
      const url = buildPreviewOpenUrl(p.previewUrl, p.visibility, token);
      if (!url) {
        setError("会话已失效，请重新登录后再打开预览");
        return;
      }
      await platform.openPreview(url);
    } catch (error) {
      showError(error, "无法打开系统浏览器，请重试");
    } finally {
      setOpeningPort(null);
    }
  };

  const copyShare = async (share: MachinePortShare) => {
    try {
      await navigator.clipboard.writeText(share.shareUrl);
      setCopiedId(share.id);
      setTimeout(() => setCopiedId((cur) => (cur === share.id ? null : cur)), 2000);
    } catch {
      showError(null, "复制失败，请手动选中链接复制");
    }
  };

  const copyPreviewUrl = async (port: MachinePort) => {
    try {
      await platform.clipboard.writeText(normalizePreviewUrlHostname(port.previewUrl));
      setCopiedPreviewUrl(port.previewUrl);
      setTimeout(
        () => setCopiedPreviewUrl((current) => (current === port.previewUrl ? null : current)),
        2000,
      );
    } catch {
      showError(null, "复制失败，请手动选中预览域名复制");
    }
  };

  const ports = portsQuery.data ?? [];
  const shares = sharesQuery.data ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部说明 + 分享过期选项 + 手动刷新 */}
      <div className="cm-toolbar h-auto min-h-8 flex-wrap gap-x-4 gap-y-1 px-3 py-1.5">
        <p className="min-w-0 flex-1 text-[11px] text-zinc-500 sm:text-xs">
          检测电脑内监听的 HTTP/WS 端口，可调整可见性、打开预览或生成免登录分享链接。
          <span className="break-all text-zinc-600">
            预览域名由端口和电脑标识组成，例如：https://端口-01m6ape8w7yt4yd1neg3ccqwd8.preview.renrencodex.com
          </span>
        </p>
        <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 sm:text-xs">
            分享有效期
            <select
              value={expiryIdx}
              onChange={(e) => setExpiryIdx(Number(e.target.value))}
              className="cm-input cm-mobile-compact-input h-8 min-w-0 flex-1 py-0 text-xs sm:h-7 sm:w-auto sm:flex-none"
            >
              {SHARE_EXPIRY_OPTIONS.map((opt, i) => (
                <option key={opt.label} value={i}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void refreshPorts()}
            disabled={manualRefreshing}
            className="cm-button"
          >
            <RefreshCw size={13} className={manualRefreshing ? "animate-spin" : ""} />
            刷新
          </button>
        </div>
      </div>

      {error && <p className="border-b px-4 py-1.5 text-xs cm-banner-danger">{error}</p>}
      {sharesQuery.isError && (
        <div className="flex items-center justify-between gap-3 border-b px-4 py-1.5 text-xs cm-banner-danger">
          <span>分享链接加载失败</span>
          <button type="button" className="cm-button" onClick={() => void sharesQuery.refetch()}>
            重试
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {portsQuery.isPending ? null : offline ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-xs text-zinc-500 sm:text-sm">
            <p>电脑离线，启动后可检测端口</p>
          </div>
        ) : portsQuery.isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-xs text-zinc-500 sm:text-sm">
            <p>端口列表加载失败</p>
            <button type="button" onClick={() => void portsQuery.refetch()} className="cm-button">
              重试
            </button>
          </div>
        ) : ports.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-xs text-zinc-500 sm:text-sm">
            未检测到端口。在电脑内启动一个监听 TCP 端口的服务后，它会自动出现在这里
          </div>
        ) : (
          <>
            <div className="divide-y divide-zinc-800 lg:hidden" aria-label="端口列表">
              {ports.map((p) => (
                <article key={`${p.protocol}-${p.port}-${p.address}`} className="space-y-3 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-zinc-200 sm:text-sm">
                        {p.port}
                        <span className="ml-1 text-[10px] text-zinc-600">
                          {p.protocol.toUpperCase()}
                        </span>
                      </p>
                      <p className="mt-1 truncate text-[11px] text-zinc-500 sm:text-xs">
                        {p.process ?? "未知进程"}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-zinc-600">{p.address}</p>
                    </div>
                    <select
                      aria-label={`${p.port} 端口可见性`}
                      value={p.visibility}
                      disabled={visibilityMutation.isPending}
                      onChange={(event) =>
                        visibilityMutation.mutate({
                          port: p.port,
                          visibility: event.target.value as PortVisibility,
                        })
                      }
                      className="cm-input cm-mobile-compact-input h-8 w-auto py-0 text-xs"
                    >
                      {(Object.keys(VISIBILITY_LABEL) as PortVisibility[]).map((visibility) => (
                        <option key={visibility} value={visibility}>
                          {VISIBILITY_LABEL[visibility]}
                        </option>
                      ))}
                    </select>
                  </div>
                  {canOpenPreview(p.protocol) ? (
                    <div className="flex min-w-0 items-center gap-2 rounded-md bg-zinc-900/60 px-2.5 py-2">
                      <span
                        title={p.previewUrl}
                        className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-400 sm:text-xs"
                      >
                        {previewDomainLabel(p.previewUrl)}
                      </span>
                      <button
                        type="button"
                        aria-label={`复制 ${p.port} 端口预览地址`}
                        onClick={() => void copyPreviewUrl(p)}
                        className="cm-button shrink-0"
                      >
                        {copiedPreviewUrl === p.previewUrl ? "已复制" : "复制"}
                      </button>
                    </div>
                  ) : (
                    <p className="text-[11px] text-zinc-600">不支持预览</p>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={!canOpenPreview(p.protocol) || openingPort === p.port}
                      onClick={() => void openPreview(p)}
                      className="cm-button-primary"
                    >
                      {openingPort === p.port ? "打开中…" : "打开预览"}
                    </button>
                    <button
                      type="button"
                      disabled={shareMutation.isPending}
                      onClick={() => shareMutation.mutate(p.port)}
                      className="cm-button"
                    >
                      生成分享链接
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <table className="hidden w-full min-w-[980px] text-sm lg:table">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                  <th className="px-4 py-2 font-medium">端口</th>
                  <th className="px-4 py-2 font-medium">进程</th>
                  <th className="px-4 py-2 font-medium">监听地址</th>
                  <th className="px-4 py-2 font-medium">预览域名</th>
                  <th className="px-4 py-2 font-medium">可见性</th>
                  <th className="px-4 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {ports.map((p) => (
                  <tr key={`${p.protocol}-${p.port}-${p.address}`}>
                    <td className="px-4 py-2 font-mono text-zinc-200">
                      {p.port}
                      <span className="ml-1 text-xs text-zinc-600">{p.protocol.toUpperCase()}</span>
                    </td>
                    <td className="max-w-40 truncate px-4 py-2 text-zinc-400">
                      {p.process ?? "-"}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-zinc-400">{p.address}</td>
                    <td className="max-w-72 px-4 py-2">
                      {canOpenPreview(p.protocol) ? (
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            title={p.previewUrl}
                            className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-400"
                          >
                            {previewDomainLabel(p.previewUrl)}
                          </span>
                          <button
                            type="button"
                            aria-label={`复制 ${p.port} 端口预览地址`}
                            onClick={() => void copyPreviewUrl(p)}
                            className="cm-button shrink-0"
                          >
                            {copiedPreviewUrl === p.previewUrl ? "已复制" : "复制"}
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-zinc-600">不支持预览</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <select
                        value={p.visibility}
                        disabled={visibilityMutation.isPending}
                        onChange={(e) =>
                          visibilityMutation.mutate({
                            port: p.port,
                            visibility: e.target.value as PortVisibility,
                          })
                        }
                        className="cm-input h-7 w-auto py-0 text-xs"
                      >
                        {(Object.keys(VISIBILITY_LABEL) as PortVisibility[]).map((v) => (
                          <option key={v} value={v}>
                            {VISIBILITY_LABEL[v]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={!canOpenPreview(p.protocol) || openingPort === p.port}
                          title={
                            canOpenPreview(p.protocol)
                              ? undefined
                              : "预览隧道仅支持 TCP/HTTP，UDP 端口无法打开预览"
                          }
                          onClick={() => void openPreview(p)}
                          className="cm-button-primary"
                        >
                          {openingPort === p.port ? "打开中…" : "打开预览"}
                        </button>
                        <button
                          type="button"
                          disabled={shareMutation.isPending}
                          onClick={() => shareMutation.mutate(p.port)}
                          className="cm-button"
                        >
                          生成分享链接
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {/* 当前电脑未过期的分享链接 */}
        {shares.length > 0 && (
          <div className="border-t border-zinc-800 px-4 py-3">
            <p className="mb-1 text-xs font-medium text-zinc-400">分享链接</p>
            <ul className="space-y-2">
              {shares.map((s) => (
                <li key={s.id} className="cm-panel flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="font-mono text-xs text-zinc-400">:{s.port}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300">
                    {s.shareUrl}
                  </span>
                  <span className="text-xs text-zinc-600">
                    {s.expiresAt ? `${new Date(s.expiresAt).toLocaleString()} 过期` : "永不过期"}
                  </span>
                  <button type="button" onClick={() => void copyShare(s)} className="cm-button">
                    {copiedId === s.id ? "已复制" : "复制"}
                  </button>
                  <button
                    type="button"
                    disabled={revokeMutation.isPending}
                    onClick={() => revokeMutation.mutate(s)}
                    className="cm-button-danger"
                  >
                    撤销
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
