"use client";

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "../host";
import { useQueryClient } from "@tanstack/react-query";
import type { HostNavigation } from "@cloud-machine/workspace-ui";
import { api } from "../lib/api";
import { navigateRetainedWorkspace } from "../lib/retained-navigation";
import {
  workspaceLocation,
  trimWorkspaces,
  connectedWorkspaceKeys,
  type WorkspaceLocation,
} from "../lib/workspace-cache";
import {
  RuntimeContext,
  useWorkbenchRuntime,
  type WorkspaceResource,
} from "./workbench-runtime-context";
export { useWorkbenchRuntime } from "./workbench-runtime-context";

const Workbench = lazy(() =>
  import("../views/DirectoryWorkbenchPage").then((m) => ({ default: m.DirectoryWorkbenchPage })),
);
/** One account-scoped owner, above route pages. Never writes source text to storage. */
export function WorkbenchRuntimeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const search = useSearchParams()?.toString() ?? "";
  const router = useRouter();
  const navigation = useMemo<HostNavigation>(
    () => ({
      push: (href) => router.push(href),
      replace: (href) => router.replace(href),
      prefetch: (href) => router.prefetch(href),
    }),
    [router],
  );
  const queryClient = useQueryClient();
  const [entries, setEntries] = useState<WorkspaceLocation[]>([]);
  const [connectionHistory, setConnectionHistory] = useState<{ key: string }[]>([]);
  const [resources, setResources] = useState<Record<string, WorkspaceResource>>({});
  const [recent, setRecent] = useState<{ href: string; label: string }[]>([]);
  const current = useMemo(() => workspaceLocation(pathname, search), [pathname, search]);
  const connected = useMemo(
    () => connectedWorkspaceKeys(connectionHistory, current?.key),
    [connectionHistory, current?.key],
  );
  useEffect(() => {
    const params = new URLSearchParams(search);
    if (!current || !params.has("session")) return;
    params.delete("session");
    navigation.replace(`${pathname}${params.size ? `?${params}` : ""}`);
  }, [current, pathname, search, navigation]);
  const currentRef = useRef(current);
  useLayoutEffect(() => {
    currentRef.current = current;
  }, [current]);
  const report = useCallback((key: string, value: WorkspaceResource | null) => {
    setResources((previous) => {
      if (value) return { ...previous, [key]: value };
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }, []);
  const evict = useCallback((key: string) => {
    setEntries((previous) => previous.filter((entry) => entry.key !== key));
    setConnectionHistory((previous) => previous.filter((entry) => entry.key !== key));
    setResources((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
    setRecent((previous) =>
      previous.filter((entry) => {
        const separator = entry.href.indexOf("?");
        const pathname = separator === -1 ? entry.href : entry.href.slice(0, separator);
        const search = separator === -1 ? "" : entry.href.slice(separator + 1);
        return workspaceLocation(pathname, search)?.key !== key;
      }),
    );
  }, []);
  const restoreCached = useCallback(
    (href: string, replace = false) => {
      const destination = new URL(href, window.location.href);
      if (destination.origin !== window.location.origin) return false;
      const target = workspaceLocation(destination.pathname, destination.search.slice(1));
      if (!target || !entries.some((entry) => entry.key === target.key)) return false;
      // 必须经宿主导航同步 pathname/search；Desktop 没有 Next.js 的 History 接管。
      if (destination.href !== window.location.href)
        navigateRetainedWorkspace(navigation, href, replace);
      return true;
    },
    [entries, navigation],
  );
  const navigateCached = useCallback(
    (href: string, replace = false) => {
      // 普通路由页面和缓存工作区都经宿主导航更新地址与 React 路由状态。
      if (!currentRef.current) return false;
      return restoreCached(href, replace);
    },
    [restoreCached],
  );
  useEffect(() => {
    const prefetched = new Map<string, number>();
    const prefetch = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const navigable = target?.closest<HTMLAnchorElement | HTMLButtonElement>(
        "a[href], button[data-prefetch-href]",
      );
      if (!navigable) return;
      const href =
        navigable instanceof HTMLAnchorElement ? navigable.href : navigable.dataset.prefetchHref;
      if (!href) return;
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const location = workspaceLocation(url.pathname, url.search.slice(1));
      if (!location) return;
      if (Date.now() - (prefetched.get(url.href) ?? 0) < 30_000) return;
      prefetched.set(url.href, Date.now());
      navigation.prefetch(url.pathname + url.search);
      // Metadata only: never start a PTY, VM or Agent as a side effect of hovering.
      void queryClient.prefetchQuery({
        queryKey: ["machine", location.machineId],
        queryFn: () => api.machines.get(location.machineId),
        staleTime: 15_000,
      });
      void queryClient.prefetchQuery({
        queryKey: ["workspace", location.workspaceId],
        queryFn: () => api.workspaces.get(location.workspaceId),
        staleTime: 30_000,
      });
      void queryClient.prefetchQuery({
        queryKey: ["workbench-layout", location.workspaceId],
        queryFn: () => api.workbench.getLayout(location.workspaceId),
        staleTime: 30_000,
      });
    };
    document.addEventListener("pointerover", prefetch);
    document.addEventListener("focusin", prefetch);
    return () => {
      document.removeEventListener("pointerover", prefetch);
      document.removeEventListener("focusin", prefetch);
    };
  }, [navigation, queryClient]);
  useEffect(() => {
    if (!current) return;
    // Route snapshots must outlive the router-owned page they came from.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEntries((previous) => [...previous.filter((entry) => entry.key !== current.key), current]);
    setConnectionHistory((previous) =>
      [...connectedWorkspaceKeys(previous, current.key)].map((key) => ({ key })),
    );
  }, [current]);
  useEffect(() => {
    // Eviction follows asynchronous resource registration, never render-time guesses.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEntries((previous) => {
      const next = trimWorkspaces(previous, current?.key, resources);
      return next.length === previous.length ? previous : next;
    });
  }, [current?.key, resources]);
  useEffect(() => {
    if (
      !/^\/machines\/[^/]+(?:\/workspaces\/[^/]+)?$/.test(pathname) ||
      pathname === "/machines/new"
    )
      return;
    const location = workspaceLocation(pathname, search);
    const machineId = pathname.split("/")[2];
    const machine = queryClient.getQueryData<{ name: string }>(["machine", machineId]);
    const workspace = location
      ? queryClient.getQueryData<{ name: string; path: string }>([
          "workspace",
          location.workspaceId,
        ])
      : null;
    const label =
      workspace?.name ?? workspace?.path ?? machine?.name ?? (location ? "项目" : "电脑概览");
    const cleanSearch = location?.search ?? search;
    const href = pathname + (cleanSearch ? `?${cleanSearch}` : "");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecent((previous) =>
      previous[0]?.href === href && previous[0]?.label === label
        ? previous
        : [{ href, label }, ...previous.filter((entry) => entry.href !== href)].slice(0, 15),
    );
  }, [pathname, search, queryClient, resources]);
  const hasUnsaved = Object.values(resources).some((resource) => resource.dirty > 0);
  useEffect(() => {
    if (!hasUnsaved) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [hasUnsaved]);
  return (
    <RuntimeContext.Provider
      value={{
        entries,
        connected,
        current,
        resources,
        report,
        evict,
        navigateCached,
        restoreCached,
        recent,
        hasUnsaved,
      }}
    >
      {children}
    </RuntimeContext.Provider>
  );
}

export function RetainedWorkspaces({ children }: { children: ReactNode }) {
  const runtime = useWorkbenchRuntime()!;
  const entries =
    runtime.current && !runtime.entries.some((entry) => entry.key === runtime.current!.key)
      ? [...runtime.entries, runtime.current]
      : runtime.entries;
  // DOM moves reset nested scroll positions even with stable React keys. Keep LRU state intact.
  const renderedEntries = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        {!runtime.current && children}
        {renderedEntries.map((entry) => {
          const active = entry.key === runtime.current?.key;
          const route = active ? runtime.current! : entry;
          return (
            <div
              key={entry.key}
              data-workspace-runtime={entry.key}
              hidden={!active}
              inert={!active}
              aria-hidden={!active}
              className="absolute inset-0"
            >
              <Suspense fallback={<div className="cm-workspace-surface h-full" />}>
                <Workbench
                  machineId={entry.machineId}
                  workspaceId={entry.workspaceId}
                  retainedRoute={route}
                  active={active}
                  retainTerminalConnection={runtime.connected.has(entry.key)}
                />
              </Suspense>
            </div>
          );
        })}
      </div>
    </div>
  );
}
