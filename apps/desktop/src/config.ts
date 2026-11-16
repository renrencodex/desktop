export interface DesktopBuildConfig {
  apiBaseUrl: string;
  gatewayWsUrl: string;
  webBaseUrl: string;
}

function parseRequiredUrl(name: string, value: string | undefined): URL {
  if (!value?.trim()) throw new Error(`缺少构建配置 ${name}`);
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} 不是有效 URL`);
  }
}

const PRODUCTION_ORIGIN = "https://renrencodex.com";
const PRODUCTION_GATEWAY_ORIGIN = "wss://renrencodex.com";
const DEVELOPMENT_API_URL = "http://localhost:3000";
const DEVELOPMENT_WEB_URL = "http://localhost:5173";
const DEVELOPMENT_GATEWAY_URL = "ws://localhost:7444";

export function resolveDesktopBuildConfig(
  env: {
    VITE_API_BASE_URL?: string;
    VITE_WEB_BASE_URL?: string;
    VITE_GATEWAY_WS_URL?: string;
  },
  production: boolean,
): DesktopBuildConfig {
  const api = parseRequiredUrl("VITE_API_BASE_URL", env.VITE_API_BASE_URL);
  const web = parseRequiredUrl("VITE_WEB_BASE_URL", env.VITE_WEB_BASE_URL);
  const gateway = parseRequiredUrl("VITE_GATEWAY_WS_URL", env.VITE_GATEWAY_WS_URL);
  const apiSecure = api.protocol === "https:";
  const webSecure = web.protocol === "https:";
  const gatewaySecure = gateway.protocol === "wss:";
  const localDevelopment =
    !production &&
    api.toString().replace(/\/$/, "") === DEVELOPMENT_API_URL &&
    web.toString().replace(/\/$/, "") === DEVELOPMENT_WEB_URL &&
    gateway.toString().replace(/\/$/, "") === DEVELOPMENT_GATEWAY_URL;
  if ((!apiSecure || !webSecure || !gatewaySecure) && !localDevelopment) {
    throw new Error("Desktop 仅允许 HTTPS/WSS；本地开发可同时使用 localhost HTTP/WS");
  }
  if (!["https:", "http:"].includes(api.protocol)) {
    throw new Error("VITE_API_BASE_URL 必须使用 HTTPS");
  }
  if (!["https:", "http:"].includes(web.protocol)) {
    throw new Error("VITE_WEB_BASE_URL 必须使用 HTTPS");
  }
  if (!["wss:", "ws:"].includes(gateway.protocol)) {
    throw new Error("VITE_GATEWAY_WS_URL 必须使用 WSS");
  }
  if (
    production &&
    (api.origin !== PRODUCTION_ORIGIN ||
      web.origin !== PRODUCTION_ORIGIN ||
      gateway.origin !== PRODUCTION_GATEWAY_ORIGIN)
  ) {
    throw new Error("Desktop 生产构建只能连接受信任的人人Codex Origin");
  }
  return {
    apiBaseUrl: api.toString().replace(/\/$/, ""),
    gatewayWsUrl: gateway.toString().replace(/\/$/, ""),
    webBaseUrl: web.toString().replace(/\/$/, ""),
  };
}
