"use client";

import type { ApiClient, User } from "@cloud-machine/api-client";
import type { PlatformApi } from "@cloud-machine/platform-api";
import type { HostNavigation, WorkspacePlatformKind } from "@cloud-machine/workspace-ui";
import {
  createContext,
  useContext,
  useMemo,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

export interface ClientLocation {
  readonly pathname: string;
  readonly search: string;
}

export interface ClientSession {
  readonly user: User | null;
  restore(): Promise<void>;
  signOut(): Promise<void>;
  getFreshAccessToken(options?: { throwOnTransientError?: boolean }): Promise<string | null>;
}

export interface ClientHostConfig {
  readonly api: ApiClient;
  readonly apiBaseUrl: string;
  readonly gatewayBaseUrl: string;
  readonly navigation: HostNavigation;
  readonly location: ClientLocation;
  readonly platform: PlatformApi;
  readonly platformKind: WorkspacePlatformKind;
  /** Desktop 随包连接器在本机的稳定绝对路径；Web/Windows PATH 模式可省略。 */
  readonly nativeConnectorPath?: string;
  readonly session: ClientSession;
  readonly sessionNotice?: ReactNode;
  readonly windowControls?: ReactNode;
}

const HostContext = createContext<ClientHostConfig | null>(null);
let activeHost: ClientHostConfig | null = null;

export function getClientHost(): ClientHostConfig {
  if (!activeHost) throw new Error("ClientUiProvider is not configured");
  return activeHost;
}

export function gatewayWebSocketUrl(pathname: string): string {
  const base = getClientHost().gatewayBaseUrl.replace(/\/$/, "");
  const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (/^wss?:\/\//.test(base)) return `${base}${suffix}`;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${base}${suffix}`;
}

export function ClientUiProvider({
  host,
  children,
}: {
  host: ClientHostConfig;
  children: ReactNode;
}) {
  // The singleton is limited to imperative API/channel adapters. Assign before
  // descendants render so React Query subscriptions cannot observe an empty host.
  // eslint-disable-next-line react-hooks/globals
  activeHost = host;
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function useClientHost(): ClientHostConfig {
  const host = useContext(HostContext);
  if (!host) throw new Error("Client UI must be rendered inside ClientUiProvider");
  return host;
}

export function useRouter(): HostNavigation {
  return useClientHost().navigation;
}

export function usePathname(): string {
  return useClientHost().location.pathname;
}

export function useSearchParams(): URLSearchParams {
  const search = useClientHost().location.search;
  return useMemo(() => new URLSearchParams(search), [search]);
}

export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  replace?: boolean;
};

export function Link({
  href,
  replace = false,
  onClick,
  onPointerEnter,
  onFocus,
  target,
  ...props
}: LinkProps) {
  const navigation = useRouter();
  const navigate = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      target === "_blank" ||
      props.download
    ) {
      return;
    }
    event.preventDefault();
    if (replace) navigation.replace(href);
    else navigation.push(href);
  };
  return (
    <a
      {...props}
      href={href}
      target={target}
      onClick={navigate}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        if (!event.defaultPrevented) navigation.prefetch(href);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        if (!event.defaultPrevented) navigation.prefetch(href);
      }}
    />
  );
}
