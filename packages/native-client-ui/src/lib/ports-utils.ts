/** Ports 面板纯函数（设计文档 Preview 章节）。 */
import type { MachinePort } from "@cloud-machine/api-client";

export type HttpPreviewPort = MachinePort & {
  exposureMode: "http";
  endpoint: { kind: "http"; url: string };
  previewUrl: string;
};

export function isHttpPreviewPort(port: MachinePort): port is HttpPreviewPort {
  return port.exposureMode === "http" && port.endpoint.kind === "http";
}

/**
 * 预览隧道是 TCP/HTTP 语义，UDP 端口没有可打开的 HTTP 预览
 * （点了必 502），Open 按钮据此禁用。
 */
export function canOpenPreview(protocol: "tcp" | "udp"): boolean {
  return protocol === "tcp";
}

/** 端口列表只展示主机名；复制和打开仍使用服务端返回的完整 previewUrl。 */
export function previewDomainLabel(previewUrl: string): string {
  try {
    return new URL(previewUrl).host.toLowerCase();
  } catch {
    return previewUrl.toLowerCase();
  }
}

/** 复制预览地址时只规范化主机名，保留协议、路径、查询参数和片段的原始大小写。 */
export function normalizePreviewUrlHostname(previewUrl: string): string {
  try {
    new URL(previewUrl);
    const authorityStart = previewUrl.indexOf("://") + 3;
    if (authorityStart < 3) return previewUrl;
    const authorityEndOffset = previewUrl.slice(authorityStart).search(/[/?#]/);
    const authorityEnd =
      authorityEndOffset === -1 ? previewUrl.length : authorityStart + authorityEndOffset;
    const authority = previewUrl.slice(authorityStart, authorityEnd);
    const userInfoEnd = authority.lastIndexOf("@") + 1;
    const hostAndPort = authority.slice(userInfoEnd);
    const lastColon = hostAndPort.lastIndexOf(":");
    const hostnameEnd = hostAndPort.startsWith("[")
      ? hostAndPort.indexOf("]") + 1
      : lastColon > 0 && /^\d+$/.test(hostAndPort.slice(lastColon + 1))
        ? lastColon
        : hostAndPort.length;
    const normalizedAuthority = `${authority.slice(0, userInfoEnd)}${hostAndPort.slice(0, hostnameEnd).toLowerCase()}${hostAndPort.slice(hostnameEnd)}`;
    return `${previewUrl.slice(0, authorityStart)}${normalizedAuthority}${previewUrl.slice(authorityEnd)}`;
  } catch {
    return previewUrl;
  }
}

/**
 * 浏览器预览按协议+端口去重。agentd 对同一端口的 IPv4/IPv6 双栈会返回两条，
 * previewUrl 却只由端口决定；下拉框若按 protocol-port 当 React key 会撞车。
 */
export function uniquePreviewPorts<T extends { protocol: string; port: number }>(ports: T[]): T[] {
  const seen = new Set<string>();
  return ports.filter((port) => {
    const key = `${port.protocol}:${port.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Keep-alive panels stay mounted; hidden panels must not continue background polling. */
export function portsRefetchInterval(active: boolean): 2000 | false {
  return active ? 2_000 : false;
}
