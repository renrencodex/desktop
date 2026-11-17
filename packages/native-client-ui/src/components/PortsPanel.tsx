/** Ports 页签：检测合规监听端口，并以禁用/放开控制预览域名。 */
import { isApiError, type MachinePort, type PortVisibility } from "@cloud-machine/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { useClientHost } from "../host";
import { api } from "../lib/api";
import {
  canOpenPreview,
  normalizePreviewUrlHostname,
  portsRefetchInterval,
  previewDomainLabel,
} from "../lib/ports-utils";
import { userErrorMessage } from "../lib/user-error";

const VISIBILITY_LABEL: Record<PortVisibility, string> = {
  private: "禁用",
  public: "放开",
};

export function PortsPanel({ machineId, active = true }: { machineId: string; active?: boolean }) {
  const { platform } = useClientHost();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [copiedPreviewUrl, setCopiedPreviewUrl] = useState<string | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const portsQuery = useQuery({
    queryKey: ["machine-ports", machineId],
    queryFn: () => api.ports.list(machineId),
    enabled: active,
    refetchInterval: portsRefetchInterval(active),
  });
  const offline =
    isApiError(portsQuery.error) && portsQuery.error.status === 503 && !portsQuery.data;

  const visibilityMutation = useMutation({
    mutationFn: ({ port, visibility }: { port: number; visibility: PortVisibility }) =>
      api.ports.setVisibility(machineId, port, visibility),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["machine-ports", machineId] });
    },
    onError: (cause) => setError(userErrorMessage(cause, "更新端口状态失败，请重试")),
  });

  const refreshPorts = async () => {
    setManualRefreshing(true);
    try {
      await portsQuery.refetch();
    } finally {
      setManualRefreshing(false);
    }
  };

  const openDomain = async (port: MachinePort) => {
    try {
      await platform.openExternal(normalizePreviewUrlHostname(port.previewUrl));
    } catch (cause) {
      setError(userErrorMessage(cause, "无法打开系统浏览器，请重试"));
    }
  };

  const copyPreviewUrl = async (port: MachinePort) => {
    try {
      await platform.clipboard.writeText(normalizePreviewUrlHostname(port.previewUrl));
      setCopiedPreviewUrl(port.previewUrl);
      setTimeout(
        () => setCopiedPreviewUrl((current) => (current === port.previewUrl ? null : current)),
        2_000,
      );
    } catch {
      setError("复制失败，请手动选中预览域名复制");
    }
  };

  const domain = (port: MachinePort, compact: boolean) => {
    if (!canOpenPreview(port.protocol)) {
      return <span className="text-xs text-zinc-600">不支持预览</span>;
    }
    const label = previewDomainLabel(port.previewUrl);
    const textClass = `${compact ? "text-[10px] sm:text-xs" : "text-xs"} min-w-0 flex-1 truncate text-left font-mono ${
      port.visibility === "public" ? "text-sky-400 hover:text-sky-500" : "text-zinc-500"
    }`;
    return (
      <div className="flex min-w-0 items-center gap-2">
        {port.visibility === "public" ? (
          <button
            type="button"
            onClick={() => void openDomain(port)}
            aria-label={`访问 ${port.port} 端口预览域名`}
            title={port.previewUrl}
            className={textClass}
          >
            {label}
          </button>
        ) : (
          <span title={port.previewUrl} className={textClass}>
            {label}
          </span>
        )}
        <button
          type="button"
          aria-label={`复制 ${port.port} 端口预览地址`}
          onClick={() => void copyPreviewUrl(port)}
          className="cm-button shrink-0"
        >
          {copiedPreviewUrl === port.previewUrl ? "已复制" : "复制"}
        </button>
      </div>
    );
  };

  const ports = portsQuery.data ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="cm-toolbar h-auto min-h-8 flex-wrap gap-x-4 gap-y-1 px-3 py-1.5">
        <p className="min-w-0 flex-1 text-[11px] text-zinc-500 sm:text-xs">
          首次检测到的 HTTP/WS 端口默认放开；如果服务包含敏感内容，请将其设为禁用。
          <span className="break-all text-zinc-600">
            预览域名示例：https://端口-01m6ape8w7yt4yd1neg3ccqwd8.preview.renrencodex.com
          </span>
        </p>
        <button
          type="button"
          onClick={() => void refreshPorts()}
          disabled={manualRefreshing}
          className="cm-button ml-auto"
        >
          <RefreshCw size={13} className={manualRefreshing ? "animate-spin" : ""} />
          刷新
        </button>
      </div>

      {error && <p className="border-b px-4 py-1.5 text-xs cm-banner-danger">{error}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {portsQuery.isPending ? null : offline ? (
          <div className="flex h-full items-center justify-center p-6 text-xs text-zinc-500 sm:text-sm">
            电脑离线，启动后可检测端口
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
              {ports.map((port) => (
                <article key={`${port.protocol}-${port.port}`} className="space-y-3 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-zinc-200 sm:text-sm">
                        {port.port}
                        <span className="ml-1 text-[10px] text-zinc-600">
                          {port.protocol.toUpperCase()}
                        </span>
                      </p>
                      <p className="mt-1 truncate text-[11px] text-zinc-500 sm:text-xs">
                        {port.process ?? "未知进程"}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-zinc-600">{port.address}</p>
                    </div>
                    <select
                      aria-label={`${port.port} 端口状态`}
                      value={port.visibility}
                      disabled={visibilityMutation.isPending}
                      onChange={(event) =>
                        visibilityMutation.mutate({
                          port: port.port,
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
                  <div className="rounded-md bg-zinc-900/60 px-2.5 py-2">{domain(port, true)}</div>
                </article>
              ))}
            </div>

            <table className="hidden w-full min-w-[760px] text-sm lg:table">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                  <th className="px-4 py-2 font-medium">端口</th>
                  <th className="px-4 py-2 font-medium">进程</th>
                  <th className="px-4 py-2 font-medium">监听地址</th>
                  <th className="px-4 py-2 font-medium">预览域名</th>
                  <th className="px-4 py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {ports.map((port) => (
                  <tr key={`${port.protocol}-${port.port}`}>
                    <td className="px-4 py-2 font-mono text-zinc-200">
                      {port.port}
                      <span className="ml-1 text-xs text-zinc-600">
                        {port.protocol.toUpperCase()}
                      </span>
                    </td>
                    <td className="max-w-40 truncate px-4 py-2 text-zinc-400">
                      {port.process ?? "-"}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-zinc-400">{port.address}</td>
                    <td className="max-w-72 px-4 py-2">{domain(port, false)}</td>
                    <td className="px-4 py-2">
                      <select
                        aria-label={`${port.port} 端口状态`}
                        value={port.visibility}
                        disabled={visibilityMutation.isPending}
                        onChange={(event) =>
                          visibilityMutation.mutate({
                            port: port.port,
                            visibility: event.target.value as PortVisibility,
                          })
                        }
                        className="cm-input h-7 w-auto py-0 text-xs"
                      >
                        {(Object.keys(VISIBILITY_LABEL) as PortVisibility[]).map((visibility) => (
                          <option key={visibility} value={visibility}>
                            {VISIBILITY_LABEL[visibility]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
