/**
 * Ports 面板纯函数（设计文档 20 节 Port Preview；Phase 5 切片 E）。
 */
import type { PortVisibility } from "@cloud-machine/api-client";

/**
 * 拼装预览目标的打开 URL（targetUrl 可包含应用路径和查询参数）：
 * - public：直接打开 targetUrl；
 * - private：首次打开需带 `?token=<fresh access token>` 认证
 *   （后端 Set-Cookie 并 302 去掉 query，之后页面资产与 WebSocket 都走 cookie），
 *   token 缺失（会话失效）时返回 null，由调用方提示重新登录。
 *
 * 分享链接（createShare 返回的 shareUrl）本身带 share_token，不经过本函数。
 */
export function buildPreviewOpenUrl(
  targetUrl: string,
  visibility: PortVisibility,
  accessToken: string | null,
): string | null {
  if (visibility === "public") return targetUrl;
  if (!accessToken) return null;
  // 不经 URLSearchParams 重新序列化，避免改写应用的签名参数或原始编码。
  const fragmentIndex = targetUrl.indexOf("#");
  const target = fragmentIndex < 0 ? targetUrl : targetUrl.slice(0, fragmentIndex);
  const fragment = fragmentIndex < 0 ? "" : targetUrl.slice(fragmentIndex);
  const separator = target.includes("?")
    ? target.endsWith("?") || target.endsWith("&")
      ? ""
      : "&"
    : "?";
  return `${target}${separator}token=${encodeURIComponent(accessToken)}${fragment}`;
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

/** 分享链接过期选项（expiresInSeconds 为 undefined 表示永不过期）。 */
export const SHARE_EXPIRY_OPTIONS = [
  { label: "1 小时", seconds: 3600 },
  { label: "8 小时", seconds: 8 * 3600 },
  { label: "24 小时", seconds: 86400 },
  { label: "48 小时", seconds: 48 * 3600 },
  { label: "72 小时", seconds: 72 * 3600 },
  { label: "7 天", seconds: 7 * 24 * 3600 },
  { label: "30 天", seconds: 30 * 24 * 3600 },
  { label: "永不过期", seconds: undefined },
] as const;
