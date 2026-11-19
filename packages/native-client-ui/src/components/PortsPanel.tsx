/** Ports 页签：检测 TCP 监听端口，选择唯一暴露模式并控制是否放开。 */
import {
  isApiError,
  type MachinePort,
  type PortExposureMode,
  type PortVisibility,
} from "@cloud-machine/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { useClientHost } from "../host";
import { api } from "../lib/api";
import {
  normalizePreviewUrlHostname,
  portsRefetchInterval,
  previewDomainLabel,
} from "../lib/ports-utils";
import { userErrorMessage } from "../lib/user-error";

const VISIBILITY_LABEL: Record<PortVisibility, string> = {
  private: "禁用",
  public: "放开",
};

const EXPOSURE_LABEL: Record<PortExposureMode, string> = {
  http: "HTTP",
  ssh: "SSH",
  tcp: "TCP",
};

const CONNECTOR_DOWNLOADS = [
  {
    label: "Windows x64",
    href: "/downloads/renrencodex-connect-windows-x64.zip",
    externalHref: "https://renrencodex.com/downloads/renrencodex-connect-windows-x64.zip",
    filename: "renrencodex-connect-windows-x64.zip",
  },
  {
    label: "macOS Universal",
    href: "/downloads/renrencodex-connect-macos-universal.tar.gz",
    externalHref: "https://renrencodex.com/downloads/renrencodex-connect-macos-universal.tar.gz",
    filename: "renrencodex-connect-macos-universal.tar.gz",
  },
  {
    label: "Linux x64",
    href: "/downloads/renrencodex-connect-linux-x64.tar.gz",
    externalHref: "https://renrencodex.com/downloads/renrencodex-connect-linux-x64.tar.gz",
    filename: "renrencodex-connect-linux-x64.tar.gz",
  },
] as const;

const CONNECTOR_CHECKSUM = {
  href: "/downloads/renrencodex-connect-SHA256SUMS",
  externalHref: "https://renrencodex.com/downloads/renrencodex-connect-SHA256SUMS",
  filename: "renrencodex-connect-SHA256SUMS",
} as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellDoubleQuote(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")}"`;
}

export function nativeEndpointCommand(
  port: MachinePort,
  nativeConnectorPath?: string,
): string | null {
  if (port.endpoint.kind === "http") return null;
  if (!nativeConnectorPath) {
    return port.endpoint.kind === "ssh" ? port.endpoint.sshCommand : port.endpoint.forwardCommand;
  }
  if (port.endpoint.kind === "ssh") {
    // OpenSSH expands percent tokens inside ProxyCommand; double % preserves a literal path byte.
    const proxyPath = nativeConnectorPath.replaceAll("%", "%%");
    const proxyCommand = `${shellDoubleQuote(proxyPath)} proxy %h`;
    return `ssh -o ${shellQuote(`ProxyCommand=${proxyCommand}`)} root@${port.endpoint.host}`;
  }
  return `${shellQuote(nativeConnectorPath)} forward ${port.endpoint.host} --listen 127.0.0.1:${port.port}`;
}

export function PortsPanel({ machineId, active = true }: { machineId: string; active?: boolean }) {
  const { platform, platformKind, nativeConnectorPath } = useClientHost();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [copiedPort, setCopiedPort] = useState<number | null>(null);
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

  const exposureMutation = useMutation({
    mutationFn: ({ port, mode }: { port: number; mode: PortExposureMode }) =>
      api.ports.setExposure(machineId, port, mode),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["machine-ports", machineId] });
    },
    onError: (cause) => setError(userErrorMessage(cause, "更新端口暴露模式失败，请重试")),
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
    if (port.endpoint.kind !== "http") return;
    try {
      await platform.openExternal(normalizePreviewUrlHostname(port.endpoint.url));
    } catch (cause) {
      setError(userErrorMessage(cause, "无法打开系统浏览器，请重试"));
    }
  };

  const openConnectorDownload = async (url: string) => {
    try {
      await platform.openExternal(url);
    } catch (cause) {
      setError(userErrorMessage(cause, "无法打开连接器下载地址，请重试"));
    }
  };

  const copyEndpoint = async (port: MachinePort) => {
    const value =
      port.endpoint.kind === "http"
        ? normalizePreviewUrlHostname(port.endpoint.url)
        : nativeEndpointCommand(port, nativeConnectorPath)!;
    try {
      await platform.clipboard.writeText(value);
      setCopiedPort(port.port);
      setTimeout(() => setCopiedPort((current) => (current === port.port ? null : current)), 2_000);
    } catch {
      setError("复制失败，请手动选中访问地址或命令复制");
    }
  };

  const endpoint = (port: MachinePort, compact: boolean) => {
    const label =
      port.endpoint.kind === "http"
        ? previewDomainLabel(port.endpoint.url)
        : port.endpoint.host.toLowerCase();
    const title =
      port.endpoint.kind === "http"
        ? port.endpoint.url
        : nativeEndpointCommand(port, nativeConnectorPath)!;
    const textClass = `${compact ? "text-[10px] sm:text-xs" : "text-xs"} min-w-0 flex-1 truncate text-left font-mono ${
      port.visibility === "public" && port.endpoint.kind === "http"
        ? "text-sky-400 hover:text-sky-500"
        : "text-zinc-500"
    }`;
    return (
      <div className="flex min-w-0 items-center gap-2">
        {port.visibility === "public" && port.endpoint.kind === "http" ? (
          <button
            type="button"
            onClick={() => void openDomain(port)}
            aria-label={`访问 ${port.port} 端口预览域名`}
            title={title}
            className={textClass}
          >
            {label}
          </button>
        ) : (
          <span title={title} className={textClass}>
            {label}
          </span>
        )}
        <button
          type="button"
          aria-label={`复制 ${port.port} 端口访问${port.endpoint.kind === "http" ? "地址" : "命令"}`}
          onClick={() => void copyEndpoint(port)}
          className="cm-button shrink-0"
        >
          {copiedPort === port.port
            ? "已复制"
            : port.endpoint.kind === "http"
              ? "复制"
              : "复制命令"}
        </button>
      </div>
    );
  };

  const setVisibility = (port: MachinePort, visibility: PortVisibility) => {
    if (
      visibility === "public" &&
      port.exposureMode !== "http" &&
      !window.confirm(
        `${EXPOSURE_LABEL[port.exposureMode]} 模式会把原始端口开放到公网。请确认目标服务已配置自己的身份认证和访问控制。`,
      )
    ) {
      return;
    }
    visibilityMutation.mutate({ port: port.port, visibility });
  };

  const ports = portsQuery.data ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="cm-toolbar h-auto min-h-8 flex-wrap gap-x-4 gap-y-1 px-3 py-1.5">
        <p className="min-w-0 flex-1 text-[11px] text-zinc-500 sm:text-xs">
          首次检测到的 TCP 监听端口默认禁用；HTTP 可直接访问，SSH/TCP 需使用官方 renrencodex-connect
          连接器。
          <span className="break-all text-zinc-600">
            预览域名示例：https://端口-01m6ape8w7yt4yd1neg3ccqwd8.preview.renrencodex.com
          </span>
          {platformKind === "web" ? (
            <span className="ml-1 inline-flex flex-wrap items-center gap-x-2">
              <span>下载连接器：</span>
              {CONNECTOR_DOWNLOADS.map((download) => (
                <a
                  key={download.href}
                  href={download.href}
                  download={download.filename}
                  className="text-sky-500 hover:text-sky-400 hover:underline"
                >
                  {download.label}
                </a>
              ))}
              <a
                href={CONNECTOR_CHECKSUM.href}
                download={CONNECTOR_CHECKSUM.filename}
                className="text-sky-500 hover:text-sky-400 hover:underline"
              >
                SHA-256
              </a>
            </span>
          ) : platformKind === "tauri-desktop" ? (
            <span className="ml-1 inline-flex flex-wrap items-center gap-x-2">
              <span className="text-emerald-600">Desktop 已内置连接器；独立版下载：</span>
              {CONNECTOR_DOWNLOADS.map((download) => (
                <a
                  key={download.externalHref}
                  href={download.externalHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sky-500 hover:text-sky-400 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    void openConnectorDownload(download.externalHref);
                  }}
                >
                  {download.label}
                </a>
              ))}
              <a
                href={CONNECTOR_CHECKSUM.externalHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-500 hover:text-sky-400 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  void openConnectorDownload(CONNECTOR_CHECKSUM.externalHref);
                }}
              >
                SHA-256
              </a>
            </span>
          ) : null}
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
                    <div className="flex shrink-0 gap-1.5">
                      <select
                        aria-label={`${port.port} 端口暴露模式`}
                        value={port.exposureMode}
                        disabled={
                          port.port === 22 ||
                          port.visibility === "public" ||
                          exposureMutation.isPending
                        }
                        onChange={(event) =>
                          exposureMutation.mutate({
                            port: port.port,
                            mode: event.target.value as PortExposureMode,
                          })
                        }
                        className="cm-input cm-mobile-compact-input h-8 w-auto py-0 text-xs"
                      >
                        {(Object.keys(EXPOSURE_LABEL) as PortExposureMode[]).map((mode) => (
                          <option key={mode} value={mode}>
                            {EXPOSURE_LABEL[mode]}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`${port.port} 端口状态`}
                        value={port.visibility}
                        disabled={visibilityMutation.isPending}
                        onChange={(event) =>
                          setVisibility(port, event.target.value as PortVisibility)
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
                  </div>
                  <div className="rounded-md bg-zinc-900/60 px-2.5 py-2">
                    {endpoint(port, true)}
                  </div>
                </article>
              ))}
            </div>

            <table className="hidden w-full min-w-[760px] text-sm lg:table">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                  <th className="px-4 py-2 font-medium">端口</th>
                  <th className="px-4 py-2 font-medium">进程</th>
                  <th className="px-4 py-2 font-medium">监听地址</th>
                  <th className="px-4 py-2 font-medium">模式</th>
                  <th className="px-4 py-2 font-medium">访问端点</th>
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
                    <td className="px-4 py-2">
                      <select
                        aria-label={`${port.port} 端口暴露模式`}
                        value={port.exposureMode}
                        disabled={
                          port.port === 22 ||
                          port.visibility === "public" ||
                          exposureMutation.isPending
                        }
                        onChange={(event) =>
                          exposureMutation.mutate({
                            port: port.port,
                            mode: event.target.value as PortExposureMode,
                          })
                        }
                        className="cm-input h-7 w-auto py-0 text-xs"
                      >
                        {(Object.keys(EXPOSURE_LABEL) as PortExposureMode[]).map((mode) => (
                          <option key={mode} value={mode}>
                            {EXPOSURE_LABEL[mode]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="max-w-72 px-4 py-2">{endpoint(port, false)}</td>
                    <td className="px-4 py-2">
                      <select
                        aria-label={`${port.port} 端口状态`}
                        value={port.visibility}
                        disabled={visibilityMutation.isPending}
                        onChange={(event) =>
                          setVisibility(port, event.target.value as PortVisibility)
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
