"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { hasCapability } from "@cloud-machine/platform-api";
import { useClientHost } from "../host";
import { api } from "../lib/api";
import { desktopLayoutGate } from "../lib/desktop-layout-state";
import { normalizeBrowserUrl, resolvePreviewTarget } from "../lib/browser-url";
import { createIsolatedPreviewId, previewBoundsForRect } from "../lib/isolated-preview";
import {
  isPreviewElementOccluded,
  useNativePreviewOccluded,
} from "../lib/native-preview-occlusion";
import { captureAndHidePreview, decodePreviewSnapshot } from "../lib/preview-snapshot";
import { PreviewLayoutContext, waitForPreviewLayout } from "../lib/native-preview-layout";
import { createPreviewTaskQueue } from "../lib/preview-task-queue";
import { combineAbortSignals } from "../lib/abort-signals";
import {
  isHttpPreviewPort,
  portsRefetchInterval,
  uniquePreviewPorts,
  type HttpPreviewPort,
} from "../lib/ports-utils";
import { useResponsiveViewport } from "../lib/responsive";

const ISOLATED_PREVIEW_ERROR = "内嵌预览加载失败，请重试或在系统浏览器中打开";

export function WorkbenchBrowser(props: {
  machineId: string;
  url: string;
  active: boolean;
  onUrlChange: (url: string) => void;
}) {
  const { machineId, url, active, onUrlChange } = props;
  const { platform } = useClientHost();
  const [previewId] = useState(createIsolatedPreviewId);
  const [address, setAddress] = useState(url);
  // 首帧等待端口列表判定禁用/放开，避免隔离 WebView 短暂加载已禁用域名。
  const [previewNavigation, setPreviewNavigation] = useState<{
    url: string;
    revision: number;
  } | null>(null);
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isPhone, isResolved } = useResponsiveViewport();
  const supportsIsolatedPreview = hasCapability(platform, "isolated-preview");
  const externalPreviewOnly = isPhone || !supportsIsolatedPreview;
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const previewOccluded = useNativePreviewOccluded(previewContainerRef);
  const [previewCover, setPreviewCover] = useState<{ dataUrl: string | null } | null>(null);
  const previewCoveredRef = useRef(false);
  const previewCreatedRef = useRef(false);
  const loadedPreviewUrlRef = useRef<string | null>(null);
  const loadedPreviewRevisionRef = useRef<number | null>(null);
  const previewOperationRef = useRef<Promise<void>>(Promise.resolve());
  const previewCaptureRef = useRef<AbortController | null>(null);
  const previewVisibleRef = useRef(false);
  const appliedBoundsRef = useRef<string | null>(null);
  const previewLayout = useContext(PreviewLayoutContext);
  const layoutCaptureRef = useRef<AbortController | null>(null);
  const layoutTransitionRef = useRef<{ signal: AbortSignal; release: () => void } | null>(null);
  const coverReleaseRef = useRef<AbortController | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const mountedRef = useRef(true);
  const navigationGenerationRef = useRef(0);
  const authorizedPreviewRef = useRef<string | null>(null);
  const previewTargetRef = useRef<{ previewUrl: string; targetUrl: string } | null>(null);
  const portsQuery = useQuery({
    queryKey: ["machine-ports", machineId],
    queryFn: () => api.ports.list(machineId),
    enabled: active,
    refetchInterval: portsRefetchInterval(active),
  });
  const previewPorts = useMemo(
    () => uniquePreviewPorts((portsQuery.data ?? []).filter(isHttpPreviewPort)),
    [portsQuery.data],
  );

  const openPort = useCallback(
    async (
      port: HttpPreviewPort,
      targetUrl: string,
      persistBaseUrl: boolean,
      openExternally = false,
    ) => {
      previewCaptureRef.current?.abort();
      layoutCaptureRef.current?.abort();
      const generation = ++navigationGenerationRef.current;
      const authorizationKey = `${port.visibility}:${port.previewUrl}`;
      authorizedPreviewRef.current = authorizationKey;
      setExternalUrl(null);
      setAddress(targetUrl);
      if (port.visibility !== "public") {
        setPreviewNavigation(null);
        setError("端口已禁用，请先在端口页放开");
        return;
      }
      previewTargetRef.current = { previewUrl: port.previewUrl, targetUrl };
      if (persistBaseUrl && url !== port.previewUrl) onUrlChange(port.previewUrl);
      setError(null);
      if (generation !== navigationGenerationRef.current) return;
      setPreviewNavigation({ url: targetUrl, revision: generation });
      if (openExternally) {
        try {
          await platform.openPreview(targetUrl);
        } catch {
          setError("无法打开系统浏览器，请重试");
        }
      }
    },
    [onUrlChange, platform, url],
  );

  const openExternal = useCallback(
    (target: string | null) => {
      if (!target) return;
      void platform.openExternal(target).catch(() => setError("无法打开系统浏览器，请重试"));
    },
    [platform],
  );

  useEffect(() => {
    if (!active || !url || portsQuery.isPending) return;
    const normalized = normalizeBrowserUrl(url, window.location.origin);
    const frame = window.requestAnimationFrame(() => {
      if (normalized.url === null || !normalized.url) {
        setPreviewNavigation(null);
        setExternalUrl(null);
        setError(normalized.url === null ? normalized.error : null);
        return;
      }
      const resolution = resolvePreviewTarget(normalized.url, previewPorts);
      if (resolution.kind === "missing-loopback-port") {
        authorizedPreviewRef.current = null;
        setPreviewNavigation(null);
        setExternalUrl(null);
        setError(`当前电脑未检测到 ${resolution.port} 端口`);
        return;
      }
      if (resolution.kind === "external") {
        authorizedPreviewRef.current = null;
        // 外部站点可能通过 frame-ancestors / X-Frame-Options 或脚本拒绝内嵌。
        // 保留地址供用户再次打开，但不在工作台的隔离预览中加载。
        setPreviewNavigation(null);
        setExternalUrl(normalized.url);
        setError(null);
        return;
      }
      const port = resolution.candidate;
      const authorizationKey = `${port.visibility}:${port.previewUrl}`;
      if (authorizedPreviewRef.current === authorizationKey) return;
      const targetUrl =
        url === port.previewUrl && previewTargetRef.current?.previewUrl === port.previewUrl
          ? previewTargetRef.current.targetUrl
          : resolution.targetUrl;
      void openPort(port, targetUrl, true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, openPort, portsQuery.isPending, previewPorts, url]);

  const navigate = () => {
    const result = normalizeBrowserUrl(address, window.location.origin);
    if (result.url === null) {
      setError(result.error);
      return;
    }
    const resolution = result.url ? resolvePreviewTarget(result.url, previewPorts) : null;
    if (resolution?.kind === "missing-loopback-port") {
      setError(
        portsQuery.isPending
          ? "正在检测电脑内的监听端口，请稍后重试"
          : `当前电脑未检测到 ${resolution.port} 端口`,
      );
      return;
    }
    // Invalid input must leave the existing preview's lifecycle and geometry observer intact.
    previewCaptureRef.current?.abort();
    layoutCaptureRef.current?.abort();
    navigationGenerationRef.current += 1;
    authorizedPreviewRef.current = null;
    setError(null);
    if (!result.url) {
      authorizedPreviewRef.current = null;
      previewTargetRef.current = null;
      setAddress("");
      onUrlChange("");
      setPreviewNavigation(null);
      setExternalUrl(null);
      return;
    }
    if (resolution?.kind === "preview") {
      void openPort(resolution.candidate, resolution.targetUrl, true, externalPreviewOnly);
      return;
    }
    setAddress(result.url);
    onUrlChange(result.url);
    previewTargetRef.current = null;
    setPreviewNavigation(null);
    setExternalUrl(result.url);
    openExternal(result.url);
  };

  const openUrl = previewNavigation?.url ?? externalUrl;
  const previewActiveRef = useRef(false);
  const previewVisibilityAllowedRef = useRef(false);
  useLayoutEffect(() => {
    previewActiveRef.current =
      isResolved && !externalPreviewOnly && active && previewNavigation !== null;
    previewVisibilityAllowedRef.current = previewActiveRef.current && !previewOccluded;
    if (!previewActiveRef.current) layoutCaptureRef.current?.abort();
  }, [active, externalPreviewOnly, isResolved, previewNavigation, previewOccluded]);

  const queuePreviewOperation = useCallback((operation: () => Promise<void>) => {
    const next = previewOperationRef.current.catch(() => undefined).then(operation);
    previewOperationRef.current = next.catch(() => undefined);
    return next;
  }, []);

  const reportPreviewFailure = useCallback(() => {
    if (mountedRef.current) {
      setError(ISOLATED_PREVIEW_ERROR);
    }
  }, []);

  const geometryQueue = useMemo(
    () => createPreviewTaskQueue(queuePreviewOperation, reportPreviewFailure),
    [queuePreviewOperation, reportPreviewFailure],
  );

  // Called only within the mutation queue. Geometry changes do not repeatedly show the child.
  const setPreviewVisible = useCallback(
    async (visible: boolean) => {
      if (previewVisibleRef.current === visible) return;
      if (!visible) coverReleaseRef.current?.abort();
      await platform.isolatedPreview.setVisible({ id: previewId, visible });
      previewVisibleRef.current = visible;
      if (visible) previewCoveredRef.current = false;
    },
    [platform, previewId],
  );

  const coverIsolatedPreview = useCallback(
    async (signal: AbortSignal) => {
      if (!previewCreatedRef.current || previewCoveredRef.current) return;
      const generation = navigationGenerationRef.current;
      await captureAndHidePreview(
        {
          shouldHide: () =>
            mountedRef.current &&
            previewActiveRef.current &&
            previewCreatedRef.current &&
            generation === navigationGenerationRef.current &&
            isPreviewElementOccluded(previewContainerRef.current),
          capture: async () => (await platform.isolatedPreview.capture({ id: previewId })).dataUrl,
          prepare: decodePreviewSnapshot,
          present: (dataUrl) => {
            coverReleaseRef.current?.abort();
            flushSync(() => setPreviewCover({ dataUrl }));
          },
          hide: async () => {
            await setPreviewVisible(false);
            previewCoveredRef.current = true;
          },
        },
        signal,
      );
    },
    [platform, previewId, setPreviewVisible],
  );

  const clearPreviewCover = useCallback(() => {
    coverReleaseRef.current?.abort();
    previewCoveredRef.current = false;
    if (mountedRef.current) setPreviewCover(null);
  }, []);

  const releasePreviewCover = useCallback(() => {
    coverReleaseRef.current?.abort();
    if (desktopLayoutGate.isSuspended()) return;
    const controller = new AbortController();
    coverReleaseRef.current = controller;
    const generation = navigationGenerationRef.current;
    // Do not hold the mutation queue while waiting for main-view frames.
    void waitForPreviewLayout(() => "paint", controller.signal).then(() => {
      if (
        !controller.signal.aborted &&
        mountedRef.current &&
        generation === navigationGenerationRef.current &&
        previewVisibleRef.current &&
        previewVisibilityAllowedRef.current &&
        !layoutTransitionRef.current &&
        !desktopLayoutGate.isSuspended() &&
        !isPreviewElementOccluded(previewContainerRef.current)
      )
        clearPreviewCover();
    });
  }, [clearPreviewCover]);

  useEffect(() => {
    if (!previewLayout) return;
    return previewLayout.register({
      async prepare(signal) {
        if (signal.aborted || !previewActiveRef.current || !previewCreatedRef.current) return;
        layoutCaptureRef.current?.abort();
        previewCaptureRef.current?.abort();
        coverReleaseRef.current?.abort();
        geometryQueue.clear();
        const controller = new AbortController();
        layoutCaptureRef.current = controller;
        const combined = combineAbortSignals([signal, controller.signal]);
        const lifetime = combined.signal;
        const release = () => {
          lifetime.removeEventListener("abort", release);
          combined.dispose();
          if (layoutCaptureRef.current === controller) layoutCaptureRef.current = null;
          if (layoutTransitionRef.current?.signal !== signal) return;
          layoutTransitionRef.current = null;
          if (mountedRef.current) setLayoutRevision((revision) => revision + 1);
        };
        layoutTransitionRef.current = { signal, release };
        if (lifetime.aborted) {
          release();
          return;
        }
        lifetime.addEventListener("abort", release, { once: true });
        const generation = navigationGenerationRef.current;
        // Capturing is read-only: do not spend the 200 ms budget behind unrelated geometry IPC.
        // Only the actual visibility mutation joins the serial queue.
        await captureAndHidePreview(
          {
            shouldHide: () =>
              mountedRef.current &&
              previewActiveRef.current &&
              previewCreatedRef.current &&
              !previewCoveredRef.current &&
              generation === navigationGenerationRef.current &&
              layoutTransitionRef.current?.signal === signal,
            capture: async () =>
              (await platform.isolatedPreview.capture({ id: previewId })).dataUrl,
            prepare: decodePreviewSnapshot,
            present: (dataUrl) => flushSync(() => setPreviewCover({ dataUrl })),
            hide: async () => {
              await queuePreviewOperation(async () => {
                if (
                  lifetime.aborted ||
                  !previewActiveRef.current ||
                  generation !== navigationGenerationRef.current ||
                  layoutTransitionRef.current?.signal !== signal
                )
                  return;
                await setPreviewVisible(false);
                previewCoveredRef.current = true;
              });
            },
          },
          lifetime,
          { requireSnapshot: true, timeoutMs: 200 },
        );
      },
      async finish(signal) {
        await waitForPreviewLayout(() => {
          const rect = previewContainerRef.current?.getBoundingClientRect();
          return rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : "missing";
        }, signal);
        if (layoutTransitionRef.current?.signal === signal) {
          layoutTransitionRef.current.release();
        }
      },
    });
  }, [geometryQueue, platform, previewId, previewLayout, queuePreviewOperation, setPreviewVisible]);

  const closeIsolatedPreview = useCallback(() => {
    if (!supportsIsolatedPreview) {
      previewCreatedRef.current = false;
      previewVisibleRef.current = false;
      appliedBoundsRef.current = null;
      loadedPreviewUrlRef.current = null;
      loadedPreviewRevisionRef.current = null;
      clearPreviewCover();
      return Promise.resolve();
    }
    return queuePreviewOperation(async () => {
      await platform.isolatedPreview.close({ id: previewId });
      previewCreatedRef.current = false;
      previewVisibleRef.current = false;
      appliedBoundsRef.current = null;
      loadedPreviewUrlRef.current = null;
      loadedPreviewRevisionRef.current = null;
      clearPreviewCover();
    }).catch(reportPreviewFailure);
  }, [
    clearPreviewCover,
    platform,
    previewId,
    queuePreviewOperation,
    reportPreviewFailure,
    supportsIsolatedPreview,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      previewCaptureRef.current?.abort();
      layoutCaptureRef.current?.abort();
      coverReleaseRef.current?.abort();
      geometryQueue.clear();
      if (supportsIsolatedPreview) {
        void queuePreviewOperation(async () => {
          await platform.isolatedPreview.close({ id: previewId });
          previewCreatedRef.current = false;
          previewVisibleRef.current = false;
          appliedBoundsRef.current = null;
          loadedPreviewUrlRef.current = null;
          loadedPreviewRevisionRef.current = null;
        });
      }
    };
  }, [geometryQueue, platform, previewId, queuePreviewOperation, supportsIsolatedPreview]);

  useEffect(() => {
    if (!isResolved) return;
    if (!previewNavigation || externalPreviewOnly) {
      void closeIsolatedPreview();
      return;
    }
    if (!active) {
      void queuePreviewOperation(async () => {
        await setPreviewVisible(false);
        clearPreviewCover();
      }).catch(reportPreviewFailure);
      return;
    }
    // Scope the signal to this effect so even queued, not-yet-started captures become obsolete
    // when the tab, navigation or overlay changes. Late native results never control visibility.
    const captureController = new AbortController();
    previewCaptureRef.current = captureController;
    const coverPreview = () => coverIsolatedPreview(captureController.signal);
    const cancelCapture = () => {
      captureController.abort();
      if (previewCaptureRef.current === captureController) previewCaptureRef.current = null;
    };
    if (previewOccluded) {
      void queuePreviewOperation(coverPreview).catch(reportPreviewFailure);
      return cancelCapture;
    }

    const element = previewContainerRef.current;
    if (!element) return cancelCapture;
    let animationFrame = 0;
    let geometryGeneration = 0;
    const canApplyGeometry = (generation: number) =>
      generation === geometryGeneration &&
      !captureController.signal.aborted &&
      !layoutTransitionRef.current &&
      !desktopLayoutGate.isSuspended();
    const syncPreview = () => {
      window.cancelAnimationFrame(animationFrame);
      if (desktopLayoutGate.isSuspended()) {
        // clear() only removes queued work. Fence native calls already awaiting a reply as well,
        // even if the window has completed another restore by the time that reply arrives.
        geometryGeneration++;
        geometryQueue.clear();
        coverReleaseRef.current?.abort();
        return;
      }
      animationFrame = window.requestAnimationFrame(() => {
        if (
          captureController.signal.aborted ||
          layoutTransitionRef.current ||
          desktopLayoutGate.isSuspended()
        )
          return;
        if (!previewVisibilityAllowedRef.current || isPreviewElementOccluded(element)) {
          if (previewCreatedRef.current) {
            void queuePreviewOperation(coverPreview).catch(reportPreviewFailure);
          }
          return;
        }
        geometryQueue.request(async () => {
          const generation = geometryGeneration;
          if (!canApplyGeometry(generation)) return;
          if (!previewVisibilityAllowedRef.current || isPreviewElementOccluded(element)) {
            if (previewCreatedRef.current) {
              await coverPreview();
            }
            return;
          }
          // Measure at execution time, not when queued: intervening layouts supersede old bounds.
          const bounds = previewBoundsForRect(element.getBoundingClientRect(), {
            width: window.innerWidth,
            height: window.innerHeight,
          });
          if (!bounds) {
            if (previewCreatedRef.current) await setPreviewVisible(false);
            return;
          }
          const boundsKey = JSON.stringify(bounds);
          if (
            loadedPreviewUrlRef.current !== previewNavigation.url ||
            loadedPreviewRevisionRef.current !== previewNavigation.revision
          ) {
            await platform.isolatedPreview.open({
              id: previewId,
              url: previewNavigation.url,
              bounds,
            });
            previewCreatedRef.current = true;
            previewVisibleRef.current = true;
            previewCoveredRef.current = false;
            appliedBoundsRef.current = boundsKey;
            loadedPreviewUrlRef.current = previewNavigation.url;
            loadedPreviewRevisionRef.current = previewNavigation.revision;
            if (!canApplyGeometry(generation)) return;
            if (!previewVisibilityAllowedRef.current || isPreviewElementOccluded(element)) {
              await coverPreview();
            } else {
              releasePreviewCover();
            }
          } else {
            if (appliedBoundsRef.current !== boundsKey) {
              await platform.isolatedPreview.setBounds({ id: previewId, bounds });
              appliedBoundsRef.current = boundsKey;
            }
            if (!canApplyGeometry(generation)) return;
            const visible =
              previewVisibilityAllowedRef.current && !isPreviewElementOccluded(element);
            if (!visible) {
              await coverPreview();
              return;
            }
            await setPreviewVisible(true);
            if (!canApplyGeometry(generation)) return;
            releasePreviewCover();
          }
        });
      });
    };

    const observer = new ResizeObserver(syncPreview);
    const stopLayout = desktopLayoutGate.subscribe(syncPreview);
    observer.observe(element);
    window.addEventListener("resize", syncPreview);
    syncPreview();
    return () => {
      stopLayout();
      cancelCapture();
      geometryQueue.clear();
      observer.disconnect();
      window.removeEventListener("resize", syncPreview);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [
    active,
    closeIsolatedPreview,
    clearPreviewCover,
    coverIsolatedPreview,
    geometryQueue,
    externalPreviewOnly,
    isResolved,
    layoutRevision,
    platform,
    previewOccluded,
    previewId,
    previewNavigation,
    queuePreviewOperation,
    reportPreviewFailure,
    releasePreviewCover,
    setPreviewVisible,
  ]);

  return (
    <div className="cm-workspace-surface flex h-full min-h-0 flex-col">
      <form
        className="cm-workbench-browser-toolbar flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-zinc-800 bg-zinc-900 p-1 sm:flex-nowrap sm:gap-2 sm:px-2 sm:py-1"
        onSubmit={(event) => {
          event.preventDefault();
          navigate();
        }}
      >
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          className="cm-input order-1 h-8 min-w-0 basis-full font-mono text-xs sm:h-7 sm:flex-1 sm:basis-auto"
          aria-label="浏览器地址"
          placeholder="此为内部浏览器，用于访问内部Web服务地址和端口"
        />
        <select
          aria-label="选择监听端口"
          className="cm-input order-2 h-8 min-w-0 flex-1 py-0 text-xs sm:h-7 sm:w-auto sm:max-w-40 sm:flex-none"
          value=""
          onChange={(event) => {
            const port = previewPorts.find(
              (candidate) => candidate.port === Number(event.target.value),
            );
            if (port) void openPort(port, port.previewUrl, true, externalPreviewOnly);
          }}
        >
          <option value="">监听端口</option>
          {previewPorts.map((port) => (
            <option key={`${port.protocol}-${port.port}-${port.address}`} value={port.port}>
              :{port.port} {port.process ? `· ${port.process}` : ""}
            </option>
          ))}
        </select>
        <button type="submit" className="cm-button-primary order-3 shrink-0">
          打开
        </button>
        <button
          type="button"
          className="cm-icon-button order-4"
          title="刷新"
          disabled={!previewNavigation}
          onClick={navigate}
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          className="cm-icon-button order-5"
          title="在外部浏览器打开"
          disabled={!openUrl}
          onClick={() => openExternal(openUrl)}
        >
          <ExternalLink size={13} />
        </button>
      </form>
      {error && <p className="border-b px-3 py-1.5 text-xs cm-banner-danger">{error}</p>}
      <div className="relative min-h-0 flex-1">
        {!isResolved ? (
          // 视口未解析前（SSR/首帧）留空，避免手机端先闪现预览再换成外链提示。
          <div className="cm-workspace-surface h-full" />
        ) : externalPreviewOnly ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <ExternalLink size={22} className="text-zinc-600" />
            <div>
              <p className="text-xs text-zinc-300">移动端预览使用系统浏览器打开</p>
              <p className="mt-1 max-w-xs truncate font-mono text-[10px] text-zinc-600">
                {openUrl || "请选择监听端口或输入 URL"}
              </p>
            </div>
            <button
              type="button"
              className="cm-button-primary"
              disabled={!openUrl}
              onClick={() => openExternal(openUrl)}
            >
              <ExternalLink size={13} /> 在系统浏览器打开
            </button>
          </div>
        ) : previewNavigation ? (
          <div
            ref={previewContainerRef}
            data-isolated-preview={previewId}
            className="cm-workspace-surface relative flex h-full w-full items-center justify-center overflow-hidden"
          >
            {previewCover &&
              (previewCover.dataUrl ? (
                <img
                  src={previewCover.dataUrl}
                  alt=""
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 h-full w-full object-fill"
                />
              ) : (
                <p role="status" className="p-6 text-xs text-zinc-500">
                  预览暂时隐藏，关闭菜单或对话框后恢复
                </p>
              ))}
            {error === ISOLATED_PREVIEW_ERROR && (
              <div className="flex flex-col items-center gap-3 p-6 text-center text-zinc-300">
                <p className="text-xs">内嵌预览暂时无法加载</p>
                <div className="flex gap-2">
                  <button type="button" className="cm-button" onClick={navigate}>
                    <RefreshCw size={13} /> 重试
                  </button>
                  <button
                    type="button"
                    className="cm-button-primary"
                    onClick={() => openExternal(openUrl)}
                  >
                    <ExternalLink size={13} /> 在系统浏览器打开
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : externalUrl ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <ExternalLink size={24} className="text-zinc-600" />
            <div>
              <p className="text-xs text-zinc-300">外部网站已在新的浏览器标签页打开</p>
              <p className="mt-1 max-w-lg truncate font-mono text-[10px] text-zinc-600">
                {externalUrl}
              </p>
            </div>
            <button
              type="button"
              className="cm-button-primary"
              onClick={() => openExternal(externalUrl)}
            >
              <ExternalLink size={13} /> 再次打开
            </button>
          </div>
        ) : (
          <div className="cm-workspace-surface h-full" />
        )}
      </div>
    </div>
  );
}
