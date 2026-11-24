import type { ApiClient, Machine, MachineProvisioningStatus } from "@cloud-machine/api-client";
import type { PlatformApi } from "@cloud-machine/platform-api";
import type { HostNavigation } from "@cloud-machine/workspace-ui";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, expect, test } from "bun:test";
import { act, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type { ClientHostConfig, ClientLocation } from "./host";

const NATIVE_GLOBALS = [
  "fetch",
  "WebSocket",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "DOMException",
  "crypto",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  "performance",
] as const;

function acquireTestDom(): () => void {
  if (!("window" in globalThis)) {
    const nativeDescriptors = new Map<string, PropertyDescriptor>();
    for (const key of NATIVE_GLOBALS) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
      if (descriptor) nativeDescriptors.set(key, descriptor);
    }
    GlobalRegistrator.register();
    for (const [key, descriptor] of nativeDescriptors) {
      Object.defineProperty(globalThis, key, descriptor);
    }
  }
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  return () => {};
}

const releaseTestDom = acquireTestDom();
const { ClientUiProvider } = await import("./host");
const { ClientRouteOutlet } = await import("./routes");
const { useAuthStore } = await import("./stores/auth");

afterAll(async () => {
  await Bun.sleep(50);
  releaseTestDom();
});

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "machine-route-test",
    name: "已创建电脑",
    slug: "machine-route-test",
    region: "cn-test-1",
    cluster: "cluster-1",
    clusterGroup: null,
    imageId: "image-1",
    planId: "plan-1",
    cpu: 2,
    memoryMb: 4096,
    diskGb: 40,
    gpuType: null,
    gpuCount: 0,
    egressLineId: "default",
    egressLineAppliedId: "default",
    lifecycleStatus: "stopped",
    powerState: "off",
    agentConnectionState: "disconnected",
    readyAt: "2026-11-24T08:00:00.000Z",
    createdAt: "2026-11-24T07:58:00.000Z",
    updatedAt: "2026-11-24T08:00:00.000Z",
    ...overrides,
  };
}

function provisioningStatus(
  overrides: Partial<MachineProvisioningStatus> = {},
): MachineProvisioningStatus {
  return {
    machineId: "machine-route-test",
    operationId: "operation-1",
    status: "ready",
    progress: 100,
    currentStep: "ready",
    steps: [
      { key: "queued", status: "completed" },
      { key: "tenant_resources", status: "completed" },
      { key: "instance", status: "completed" },
      { key: "boot", status: "completed" },
      { key: "agent", status: "completed" },
      { key: "workspace", status: "completed" },
      { key: "ready", status: "completed" },
    ],
    attempt: 1,
    maxAttempts: 3,
    ready: true,
    canOpenWorkspace: true,
    defaultWorkspaceId: "workspace-default",
    recoveryAction: null,
    error: null,
    updatedAt: "2026-11-24T08:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function apiDouble(options: {
  detail: () => Promise<Machine>;
  provisioning: () => Promise<MachineProvisioningStatus>;
}): ApiClient {
  return {
    account: {
      getBillingCapabilities: async () => ({ enabled: false }),
    },
    auth: {
      me: async () => {
        throw new Error("current user query must stay disabled without a session");
      },
    },
    cliStore: {
      catalog: async () => [],
      inventory: async () => ({
        online: false,
        supported: false,
        agentContractVersion: null,
        installations: [],
        operation: null,
      }),
    },
    machines: {
      connection: async () => ({
        online: false,
        agentVersion: null,
        contractVersion: null,
        gateway: null,
      }),
      get: options.detail,
      listEgressLines: async () => [],
      provisioning: options.provisioning,
    },
    plans: { list: async () => [] },
  } as unknown as ApiClient;
}

function TestRouteApp(props: {
  api: ApiClient;
  initialPath: string;
  onReplace: (path: string) => void;
  queryClient: QueryClient;
}) {
  const { api, initialPath, onReplace, queryClient } = props;
  const [location, setLocation] = useState<ClientLocation>({
    pathname: initialPath,
    search: "",
  });
  const locationRef = useRef(location);
  useLayoutEffect(() => {
    locationRef.current = location;
  }, [location]);
  const navigate = useCallback(
    (href: string) => {
      const url = new URL(href, "https://desktop.test");
      const next = { pathname: url.pathname, search: url.search };
      const current = locationRef.current;
      if (current.pathname === next.pathname && current.search === next.search) return;
      locationRef.current = next;
      onReplace(next.pathname + next.search);
      setLocation(next);
    },
    [onReplace],
  );
  const navigation = useMemo<HostNavigation>(
    () => ({ push: navigate, replace: navigate, prefetch: () => {} }),
    [navigate],
  );
  const host = useMemo<ClientHostConfig>(
    () => ({
      api,
      apiBaseUrl: "https://api.desktop.test",
      gatewayBaseUrl: "wss://gateway.desktop.test",
      navigation,
      location,
      platform: {} as PlatformApi,
      platformKind: "tauri-desktop",
      session: {
        user: null,
        restore: async () => {},
        signOut: async () => {},
        getFreshAccessToken: async () => null,
      },
    }),
    [api, location, navigation],
  );

  return (
    <ClientUiProvider host={host}>
      <QueryClientProvider client={queryClient}>
        <ClientRouteOutlet />
      </QueryClientProvider>
    </ClientUiProvider>
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms`);
    await Bun.sleep(20);
  }
}

test("ready provisioning transitions once and waits for fresh detail without a route loop", async () => {
  useAuthStore.getState().markUnauthenticated();
  const ready = machine();
  const stale = machine({
    lifecycleStatus: "provisioning",
    powerState: "unknown",
    agentConnectionState: "never_connected",
    readyAt: null,
    updatedAt: "2026-11-24T07:59:00.000Z",
  });
  const readyStatus = provisioningStatus();
  const detail = deferred<Machine>();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["machine", ready.id], stale);
  queryClient.setQueryData(["machine-provisioning", ready.id], readyStatus);
  const transitions: string[] = [];
  const onReplace = (path: string) => transitions.push(path);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <TestRouteApp
          api={apiDouble({
            detail: () => detail.promise,
            provisioning: async () => readyStatus,
          })}
          initialPath={`/machines/${ready.id}/provisioning`}
          onReplace={onReplace}
          queryClient={queryClient}
        />,
      );
    });
    await act(async () => {
      await waitFor(() => transitions.length === 1);
      await Bun.sleep(20);
    });

    expect(transitions).toEqual([`/machines/${ready.id}`]);
    expect(container.textContent).not.toContain(ready.name);

    await act(async () => {
      detail.resolve(ready);
      await waitFor(() => (container.textContent ?? "").includes(ready.name));
    });

    expect(transitions).toEqual([`/machines/${ready.id}`]);
    expect(queryClient.getQueryData(["machine-provisioning", ready.id])).toBeUndefined();
  } finally {
    detail.resolve(ready);
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});

test("a genuinely non-ready detail still redirects once to provisioning", async () => {
  useAuthStore.getState().markUnauthenticated();
  const notReady = machine({
    lifecycleStatus: "provisioning",
    powerState: "unknown",
    agentConnectionState: "never_connected",
    readyAt: null,
  });
  const inProgress = provisioningStatus({
    status: "in_progress",
    progress: 85,
    currentStep: "agent",
    ready: false,
    canOpenWorkspace: false,
    defaultWorkspaceId: null,
    steps: provisioningStatus().steps.map((step) =>
      step.key === "agent"
        ? { ...step, status: "active" }
        : step.key === "workspace" || step.key === "ready"
          ? { ...step, status: "pending" }
          : step,
    ),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["machine", notReady.id], notReady);
  const transitions: string[] = [];
  const onReplace = (path: string) => transitions.push(path);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <TestRouteApp
          api={apiDouble({
            detail: async () => notReady,
            provisioning: async () => inProgress,
          })}
          initialPath={`/machines/${notReady.id}`}
          onReplace={onReplace}
          queryClient={queryClient}
        />,
      );
    });
    await act(async () => {
      await waitFor(() => transitions.length === 1);
    });

    expect(transitions).toEqual([`/machines/${notReady.id}/provisioning`]);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});
