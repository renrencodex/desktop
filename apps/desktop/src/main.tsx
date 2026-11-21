import {
  Component,
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  createApiClient,
  DESKTOP_OAUTH_CLIENT_ID,
  DESKTOP_OAUTH_REDIRECT_URI,
  isApiError,
  type User,
} from "@cloud-machine/api-client";
import {
  buildDesktopAuthorizeUrl,
  createDesktopAuthorizationAttempt,
  parseDesktopAuthorizationCallback,
  type DesktopAuthorizationAttempt,
} from "@cloud-machine/client-core";
import { createTauriPlatformApi } from "@cloud-machine/platform-api/tauri";
import type { HostNavigation } from "@cloud-machine/workspace-ui";
import {
  AuthedLayout,
  ClientRouteOutlet,
  ClientUiProvider,
  DesktopUpdateProvider,
  Toaster,
  initializeTheme,
  useAuthStore,
  useThemeStore,
  useWorkbenchStore,
  type ClientHostConfig,
  BrandLogo,
  createNativeThemeSync,
  machineMetricsCache,
  preloadDirectoryWorkbench,
} from "@cloud-machine/native-client-ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "./app.css";
import { bindDesktopWindowViewport } from "./desktop-window-viewport";
import { scheduleDesktopStartup } from "./desktop-startup";
import { resolveDesktopBuildConfig } from "./config";
import {
  handleDesktopCloseRequest,
  handleDesktopExitRequest,
  readDesktopHistoryIndex,
  sessionExpiryDisposition,
  withDesktopHistoryIndex,
} from "./lifecycle";
import { classifyDesktopAuthorizationCallback } from "./oauth-callback";

const REFRESH_TOKEN_KEY = "desktop-refresh-token";
const DESKTOP_EXIT_REQUESTED_EVENT = "desktop-exit-requested";
const isWindowsDesktop = navigator.userAgent.includes("Windows");
const platform = createTauriPlatformApi({
  invoke,
  listen,
  createChannel: (onMessage) => new Channel(onMessage),
  appUpdateEnabled: true,
});
const tokenState: { access: string | null; refresh: string | null } = {
  access: null,
  refresh: null,
};
let sessionExpiredListener: (() => void) | null = null;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
const initialThemeId = initializeTheme();
const desktopWindow = getCurrentWindow();
const desktopViewport = bindDesktopWindowViewport(desktopWindow, window);
if (import.meta.hot) import.meta.hot.dispose(() => desktopViewport.dispose());
// Tauri propagates the window theme to existing child webviews and initializes new children from it.
// Keep this as the only native theme path; direct WebView2 writes can race the Windows event loop.
const synchronizeNativeTheme = createNativeThemeSync((theme) => desktopWindow.setTheme(theme));
function syncNativeWindowTheme(themeId: Parameters<typeof synchronizeNativeTheme>[0]) {
  return synchronizeNativeTheme(themeId).catch((error: unknown) => {
    console.error("Desktop native theme synchronization failed", error);
  });
}

const initialNativeTheme = syncNativeWindowTheme(initialThemeId);
const stopNativeThemeSync = useThemeStore.subscribe((state) => {
  syncNativeWindowTheme(state.themeId);
});
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopNativeThemeSync();
  });

function DesktopStartupReady() {
  useLayoutEffect(() => {
    if (!isWindowsDesktop) return;
    return scheduleDesktopStartup({
      appearance: Promise.all([initialNativeTheme, document.fonts.ready]),
      readSize: () => ({
        width: window.innerWidth,
        height: window.innerHeight,
        pixelRatio: window.devicePixelRatio,
      }),
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id),
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: (id) => window.clearTimeout(id),
      ready: () => {
        void invoke<void>("desktop_startup_ready").catch((error: unknown) => {
          console.error("Desktop startup notification failed", error);
        });
      },
    });
  }, []);
  return null;
}

let config: ReturnType<typeof resolveDesktopBuildConfig> | null = null;
let configError: string | null = null;
try {
  config = resolveDesktopBuildConfig(import.meta.env, import.meta.env.PROD);
} catch (error) {
  configError = error instanceof Error ? error.message : "Desktop 构建配置无效";
}

const api = createApiClient({
  baseUrl: config?.apiBaseUrl ?? "",
  getAccessToken: () => tokenState.access,
  setAccessToken: (value) => {
    tokenState.access = value;
  },
  nativeSession: {
    kind: "desktop",
    getRefreshToken: () => tokenState.refresh,
    setRefreshToken: async (value) => {
      if (value === null) {
        tokenState.refresh = null;
        await platform.secureStorage.remove(REFRESH_TOKEN_KEY);
      } else {
        await platform.secureStorage.set(REFRESH_TOKEN_KEY, value);
        tokenState.refresh = value;
      }
    },
  },
  onSessionExpired: () => sessionExpiredListener?.(),
});

function WindowControls() {
  const win = getCurrentWindow();
  const hideToTray = () => {
    void desktopViewport
      .hideToTray()
      .catch((error: unknown) => console.error("Desktop tray hide failed", error));
  };
  return (
    <div className="desktop-window-controls">
      <button aria-label="最小化" onClick={hideToTray}>
        —
      </button>
      <button aria-label="最大化" onClick={() => void win.toggleMaximize()}>
        ▢
      </button>
      <button className="desktop-close" aria-label="关闭" onClick={hideToTray}>
        ×
      </button>
    </div>
  );
}

function Titlebar() {
  return (
    <header data-tauri-drag-region className="desktop-titlebar">
      <span data-tauri-drag-region className="desktop-title">
        人人Codex Desktop
      </span>
      <WindowControls />
    </header>
  );
}

type SessionState =
  | { status: "booting" }
  | { status: "unauthenticated"; message?: string }
  | { status: "authenticated"; user: User }
  | { status: "error"; message: string };

let restorePromise: Promise<User | null> | null = null;

function restoreDesktopSession(): Promise<User | null> {
  restorePromise ??= (async () => {
    const refreshToken = await platform.secureStorage.get(REFRESH_TOKEN_KEY);
    tokenState.refresh = refreshToken;
    if (!refreshToken) return null;
    try {
      await api.desktopAuth.refresh();
      return await api.auth.me();
    } catch (error) {
      if (isApiError(error) && (error.status === 401 || error.status === 403)) {
        return null;
      }
      throw error;
    }
  })().finally(() => {
    restorePromise = null;
  });
  return restorePromise;
}

function DesktopApp() {
  const [session, setSession] = useState<SessionState>({ status: "booting" });
  const pendingAuthorization = useRef<DesktopAuthorizationAttempt | null>(null);
  const authorizationOperation = useRef<"idle" | "opening" | "pending" | "exchange">("idle");
  const [authorizationPending, setAuthorizationPending] = useState(false);
  const [pathname, setPathname] = useState(() => window.location.pathname || "/");
  const [search, setSearch] = useState(() => window.location.search);
  const [dirty, setDirty] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [sessionRecoveryRequired, setSessionRecoveryRequired] = useState(false);
  const dirtyRef = useRef(false);
  const updateBusyRef = useRef(false);
  const historyIndex = useRef(readDesktopHistoryIndex(window.history.state) ?? 0);

  useLayoutEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventNativeContextMenu, true);
    return () => document.removeEventListener("contextmenu", preventNativeContextMenu, true);
  }, []);

  const onDirtyChange = useCallback((nextDirty: boolean) => {
    dirtyRef.current = nextDirty;
    setDirty(nextDirty);
  }, []);

  const onUpdateBusyChange = useCallback((busy: boolean) => {
    updateBusyRef.current = busy;
    setUpdateBusy(busy);
  }, []);

  const restore = useCallback(() => {
    setSession({ status: "booting" });
    void restoreDesktopSession()
      .then((user) =>
        setSession(user ? { status: "authenticated", user } : { status: "unauthenticated" }),
      )
      .catch((error: unknown) =>
        setSession({
          status: "error",
          message: error instanceof Error ? error.message : "安全会话恢复失败",
        }),
      );
  }, []);

  useEffect(() => {
    let cancelled = false;
    void restoreDesktopSession()
      .then((user) => {
        if (!cancelled) {
          setSession(user ? { status: "authenticated", user } : { status: "unauthenticated" });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSession({
            status: "error",
            message: error instanceof Error ? error.message : "安全会话恢复失败",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    sessionExpiredListener = () => {
      machineMetricsCache.setAccount(null);
      pendingAuthorization.current = null;
      authorizationOperation.current = "idle";
      setAuthorizationPending(false);
      if (sessionExpiryDisposition(dirtyRef.current) === "preserve-draft") {
        // Keep the local editor mounted so an expired remote session cannot discard a draft.
        setSessionRecoveryRequired(true);
        return;
      }
      queryClient.clear();
      setSession({ status: "unauthenticated", message: "登录会话已失效，请重新登录" });
    };
    return () => {
      sessionExpiredListener = null;
    };
  }, []);

  const navigate = useCallback((href: string, replace: boolean) => {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) throw new Error("Desktop 路由必须为本地地址");
    const destination = url.pathname + url.search;
    if (destination === window.location.pathname + window.location.search) return true;
    if (replace) {
      window.history.replaceState(
        withDesktopHistoryIndex(window.history.state, historyIndex.current),
        "",
        destination,
      );
    } else {
      historyIndex.current += 1;
      window.history.pushState(
        withDesktopHistoryIndex(null, historyIndex.current),
        "",
        destination,
      );
    }
    setPathname(url.pathname);
    setSearch(url.search);
    return true;
  }, []);

  const navigation = useMemo<HostNavigation>(() => {
    return {
      push: (href) => {
        navigate(href, false);
      },
      replace: (href) => {
        navigate(href, true);
      },
      prefetch: (href) => {
        if (/^\/machines\/[^/]+\/workspaces\/[^/]+(?:[/?#]|$)/.test(href))
          preloadDirectoryWorkbench();
      },
    };
  }, [navigate]);

  useEffect(() => {
    window.history.replaceState(
      withDesktopHistoryIndex(window.history.state, historyIndex.current),
      "",
      window.location.href,
    );
    const pop = (event: PopStateEvent) => {
      const targetIndex = readDesktopHistoryIndex(event.state);
      if (targetIndex === null) {
        historyIndex.current -= 1;
        window.history.replaceState(
          withDesktopHistoryIndex(event.state, historyIndex.current),
          "",
          window.location.href,
        );
      } else {
        historyIndex.current = targetIndex;
      }
      setPathname(window.location.pathname || "/");
      setSearch(window.location.search);
    };
    // 工作台的未保存拦截器监听 capture 阶段；这里只在其放行后同步路由状态。
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  useEffect(() => {
    if (!dirty && !updateBusy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, updateBusy]);

  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void win
      .onCloseRequested((event) => {
        void handleDesktopCloseRequest({
          preventDefault: () => event.preventDefault(),
          hide: () => desktopViewport.hideToTray(),
        }).catch((error: unknown) => console.error("Desktop close request failed", error));
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let handling = false;
    let unlisten: (() => void) | undefined;
    const consumeExitRequest = async () => {
      let acquired = false;
      try {
        const pending = await invoke<boolean>("take_pending_desktop_exit");
        if (!pending || handling) return;
        handling = true;
        acquired = true;
        await handleDesktopExitRequest({
          dirty: dirtyRef.current,
          updateBusy: updateBusyRef.current,
          confirm: () => window.confirm("当前文件尚未保存，退出应用会丢失修改。确定退出吗？"),
          notifyUpdateBusy: () => window.alert("正在安装更新，暂时无法退出应用。"),
          restore: () => invoke<void>("desktop_restore"),
          exit: () => invoke<void>("desktop_exit"),
        });
      } catch (error) {
        console.error("Desktop exit request failed", error);
      } finally {
        if (acquired) handling = false;
      }
    };
    void listen(DESKTOP_EXIT_REQUESTED_EVENT, () => {
      void consumeExitRequest();
    })
      .then((stop) => {
        if (disposed) stop();
        else {
          unlisten = stop;
          void consumeExitRequest();
        }
      })
      .catch((error: unknown) => console.error("Desktop exit request listener failed", error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(
    () =>
      platform.onDeepLink((value) => {
        const callback = parseDesktopAuthorizationCallback(value);
        const pending = pendingAuthorization.current;
        const disposition = classifyDesktopAuthorizationCallback(pending, callback);
        // 其他 state 的合法回调是迟到或伪造的尝试，不能消费当前 verifier。
        if (disposition === "ignore") return;
        if (disposition === "invalid") {
          setSession({
            status: "unauthenticated",
            message: "收到无法识别的授权回调；当前登录仍在等待浏览器完成",
          });
          return;
        }
        if (!pending || !callback || authorizationOperation.current === "exchange") return;
        // 回调仅可消费一次；exchange 失败也必须重新生成 state/verifier。
        pendingAuthorization.current = null;
        authorizationOperation.current = "exchange";
        setSession({ status: "booting" });
        void api.desktopAuth
          .exchangeAuthorizationCode({
            grantType: "authorization_code",
            clientId: DESKTOP_OAUTH_CLIENT_ID,
            redirectUri: DESKTOP_OAUTH_REDIRECT_URI,
            authorizationCode: callback.authorizationCode,
            codeVerifier: pending.codeVerifier,
          })
          .then(() => api.auth.me())
          .then((user) => {
            queryClient.clear();
            setSession({ status: "authenticated", user });
            navigate("/", true);
          })
          .catch((error: unknown) =>
            setSession({
              status: "unauthenticated",
              message: error instanceof Error ? error.message : "授权交换失败，请重试",
            }),
          )
          .finally(() => {
            authorizationOperation.current = "idle";
            setAuthorizationPending(false);
          });
      }),
    [navigate],
  );

  const beginLogin = async () => {
    if (!config || authorizationOperation.current !== "idle") return;
    authorizationOperation.current = "opening";
    setAuthorizationPending(true);
    const exchangeStarted = () => authorizationOperation.current === "exchange";
    try {
      const attempt = await createDesktopAuthorizationAttempt();
      pendingAuthorization.current = attempt;
      authorizationOperation.current = "pending";
      const deviceName = `人人Codex Desktop (${navigator.platform || "Desktop"})`;
      await platform.openExternal(buildDesktopAuthorizeUrl(config.webBaseUrl, attempt, deviceName));
      if (authorizationOperation.current === "pending") {
        setSession({ status: "unauthenticated", message: "已打开浏览器，请完成授权" });
      }
    } catch (error) {
      if (!exchangeStarted()) {
        pendingAuthorization.current = null;
        authorizationOperation.current = "idle";
        setAuthorizationPending(false);
        setSession({
          status: "unauthenticated",
          message: error instanceof Error ? error.message : "无法打开系统浏览器",
        });
      }
    }
  };

  const logout = async () => {
    try {
      await api.desktopAuth.revoke();
    } finally {
      pendingAuthorization.current = null;
      authorizationOperation.current = "idle";
      setAuthorizationPending(false);
      dirtyRef.current = false;
      setDirty(false);
      setSessionRecoveryRequired(false);
      queryClient.clear();
      navigate("/", true);
      setSession({ status: "unauthenticated" });
    }
  };

  const discardDraftAndLogin = () => {
    if (
      !window.confirm(
        "重新登录会卸载当前工作台并放弃未保存修改。请先复制需要保留的内容，确定继续吗？",
      )
    )
      return;
    dirtyRef.current = false;
    setDirty(false);
    setSessionRecoveryRequired(false);
    queryClient.clear();
    setSession({ status: "unauthenticated", message: "请重新完成浏览器授权" });
    void beginLogin();
  };

  return (
    <DesktopUpdateProvider platform={platform} hasUnsaved={dirty} onBusyChange={onUpdateBusyChange}>
      <main className="desktop-app client-root">
        {configError || !config ? (
          <>
            <Titlebar />
            <StatusPage title="Desktop 配置错误" message={configError ?? "构建配置缺失"} />
          </>
        ) : session.status === "booting" ? (
          <>
            <Titlebar />
            <StatusPage
              title="正在恢复会话"
              titleClassName="desktop-session-restoring-title"
              message="重新获取登录授权…"
            />
          </>
        ) : session.status === "error" ? (
          <>
            <Titlebar />
            <StatusPage title="无法启动 Desktop" message={session.message} action={restore} />
          </>
        ) : session.status === "unauthenticated" ? (
          <>
            <Titlebar />
            <LoginPage
              message={session.message}
              pending={authorizationPending}
              onLogin={() => void beginLogin()}
            />
          </>
        ) : (
          <AuthenticatedApp
            config={config}
            user={session.user}
            pathname={pathname}
            search={search}
            navigation={navigation}
            onDirtyChange={onDirtyChange}
            onLogout={logout}
            sessionRecoveryRequired={sessionRecoveryRequired}
            onDiscardDraftAndLogin={discardDraftAndLogin}
          />
        )}
      </main>
    </DesktopUpdateProvider>
  );
}

function LoginPage(props: { message?: string; pending: boolean; onLogin: () => void }) {
  return (
    <div className="desktop-centered">
      <section className="desktop-card">
        <BrandLogo className="desktop-auth-logo" mark="app-icon" />
        <h1>授权登录</h1>
        <p>请在系统浏览器中完成授权</p>
        {props.message && <div className="desktop-notice">{props.message}</div>}
        <button
          className="desktop-primary"
          type="button"
          disabled={props.pending}
          onClick={props.onLogin}
        >
          {props.pending ? "等待授权…" : "前往授权"}
        </button>
      </section>
    </div>
  );
}

function StatusPage(props: {
  title: string;
  titleClassName?: string;
  message: string;
  action?: () => void;
}) {
  return (
    <div className="desktop-centered">
      <section className="desktop-card">
        <h1 className={props.titleClassName}>{props.title}</h1>
        <p>{props.message}</p>
        {props.action && (
          <button className="desktop-primary" type="button" onClick={props.action}>
            重试
          </button>
        )}
      </section>
    </div>
  );
}

function AuthenticatedApp(props: {
  config: NonNullable<typeof config>;
  user: User;
  pathname: string;
  search: string;
  navigation: HostNavigation;
  onDirtyChange: (dirty: boolean) => void;
  onLogout: () => Promise<void>;
  sessionRecoveryRequired: boolean;
  onDiscardDraftAndLogin: () => void;
}) {
  const dirtyFileCount = useWorkbenchStore((state) => state.dirtyFileCount);
  const [nativeConnectorPath, setNativeConnectorPath] = useState<string>();
  const {
    config: desktopConfig,
    user,
    pathname,
    search,
    navigation,
    onDirtyChange,
    onLogout,
    sessionRecoveryRequired,
    onDiscardDraftAndLogin,
  } = props;

  useLayoutEffect(() => {
    useAuthStore.getState().setSession(user, tokenState.access ?? "desktop-session");
    if (sessionRecoveryRequired) machineMetricsCache.setAccount(null);
  }, [user, sessionRecoveryRequired]);

  useLayoutEffect(() => () => machineMetricsCache.setAccount(null), []);

  useEffect(() => {
    onDirtyChange(dirtyFileCount > 0);
  }, [dirtyFileCount, onDirtyChange]);

  useEffect(() => {
    if (isWindowsDesktop) return;
    let active = true;
    void invoke<string | null>("native_connector_path")
      .then((path) => {
        if (active && path) setNativeConnectorPath(path);
      })
      .catch((error: unknown) => {
        console.error("Desktop native connector path is unavailable", error);
      });
    return () => {
      active = false;
    };
  }, []);

  const host = useMemo<ClientHostConfig>(
    () => ({
      api,
      apiBaseUrl: desktopConfig.apiBaseUrl,
      gatewayBaseUrl: desktopConfig.gatewayWsUrl,
      navigation,
      location: { pathname, search },
      platform,
      platformKind: "tauri-desktop",
      nativeConnectorPath,
      session: {
        user,
        restore: () => Promise.resolve(),
        signOut: onLogout,
        getFreshAccessToken: async (options = {}) => {
          try {
            await api.desktopAuth.refresh();
            return tokenState.access;
          } catch (error) {
            const expired = isApiError(error) && (error.status === 401 || error.status === 403);
            if (options.throwOnTransientError && !expired) throw error;
            return null;
          }
        },
      },
      sessionNotice: sessionRecoveryRequired ? (
        <div className="desktop-session-expired" role="alert">
          <span>登录会话已失效。未保存内容仍保留在本窗口，请先复制需要保留的内容。</span>
          <button type="button" onClick={onDiscardDraftAndLogin}>
            放弃修改并重新登录
          </button>
        </div>
      ) : undefined,
      windowControls: <WindowControls />,
    }),
    [
      desktopConfig.apiBaseUrl,
      desktopConfig.gatewayWsUrl,
      navigation,
      nativeConnectorPath,
      onDiscardDraftAndLogin,
      onLogout,
      pathname,
      search,
      sessionRecoveryRequired,
      user,
    ],
  );

  return (
    <ClientUiProvider host={host}>
      <AuthedLayout>
        <ClientRouteOutlet />
      </AuthedLayout>
      <Toaster />
    </ClientUiProvider>
  );
}

class DesktopErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Desktop UI failed", error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <main className="desktop-app">
          <Titlebar />
          <StatusPage title="界面发生错误" message={this.state.error.message} />
        </main>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DesktopStartupReady />
    <DesktopErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <DesktopApp />
      </QueryClientProvider>
    </DesktopErrorBoundary>
  </StrictMode>,
);
