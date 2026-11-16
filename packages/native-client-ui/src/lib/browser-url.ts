export type BrowserUrlResult = { url: string; error: null } | { url: null; error: string };

export type PreviewUrlCandidate = { port: number; previewUrl: string };
export type PreviewTargetResolution<T extends PreviewUrlCandidate> =
  | { kind: "preview"; candidate: T; targetUrl: string }
  | { kind: "missing-loopback-port"; port: number }
  | { kind: "external" };

function urlOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * 将当前虚拟机的 Preview URL 与应用输出的回环地址统一为可打开目标。
 * 回环地址只能映射到 agentd 已检测的端口，避免误访用户设备的 localhost。
 */
export function resolvePreviewTarget<T extends PreviewUrlCandidate>(
  value: string,
  candidates: readonly T[],
): PreviewTargetResolution<T> {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return { kind: "external" };
  }

  const direct = candidates.find((candidate) => urlOrigin(candidate.previewUrl) === target.origin);
  if (direct) return { kind: "preview", candidate: direct, targetUrl: target.href };

  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
    return { kind: "external" };
  }
  const port = Number(target.port || (target.protocol === "http:" ? 80 : 443));
  const candidate = candidates.find((entry) => entry.port === port);
  if (!candidate) return { kind: "missing-loopback-port", port };

  const previewOrigin = urlOrigin(candidate.previewUrl);
  if (!previewOrigin) return { kind: "external" };
  const suffix = target.href.slice(target.origin.length);
  return { kind: "preview", candidate, targetUrl: `${previewOrigin}${suffix}` };
}

/** 规范化工作台浏览器地址，并阻止危险协议、凭据和主应用自身 origin。 */
export function normalizeBrowserUrl(raw: string, applicationOrigin: string): BrowserUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) return { url: "", error: null };
  const explicitHttp = /^https?:\/\//i.test(trimmed);
  const hostWithPort = /^[^/?#\s:]+:\d+(?:[/?#]|$)/i.test(trimmed);
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !explicitHttp && !hostWithPort) {
    return { url: null, error: "浏览器标签只允许 HTTP 或 HTTPS 地址" };
  }
  const candidate = explicitHttp ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { url: null, error: "请输入有效的网址" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url: null, error: "浏览器标签只允许 HTTP 或 HTTPS 地址" };
  }
  if (
    parsed.protocol === "http:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
  ) {
    return { url: null, error: "Desktop 仅允许打开 HTTPS 地址；HTTP 仅用于本机端口预览" };
  }
  if (parsed.username || parsed.password) {
    return { url: null, error: "地址中不能包含用户名或密码" };
  }
  if (parsed.origin === applicationOrigin) {
    return { url: null, error: "不能在预览浏览器中加载主应用自身地址" };
  }
  return { url: parsed.href, error: null };
}
