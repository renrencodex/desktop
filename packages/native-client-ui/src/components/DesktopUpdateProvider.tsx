"use client";

import { hasCapability, type PlatformApi } from "@cloud-machine/platform-api";
import type { DesktopUpdateInfo } from "@cloud-machine/platform-api";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  INITIAL_DESKTOP_UPDATE_DOWNLOAD,
  PREPARING_DESKTOP_UPDATE_DOWNLOAD,
  applyDesktopUpdateProgress,
  desktopUpdateProgressPercent,
  formatDesktopUpdateBytes,
  type DesktopUpdateDownloadState,
} from "../lib/desktop-updates";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type DesktopUpdateCheckStatus = "idle" | "checking" | "current" | "available" | "error";

interface DesktopUpdateContextValue {
  supported: boolean;
  currentVersion: string | null;
  availableUpdate: DesktopUpdateInfo | null;
  checkStatus: DesktopUpdateCheckStatus;
  installState: DesktopUpdateDownloadState;
  error: string | null;
  check(): Promise<void>;
  showAvailable(): void;
}

const DesktopUpdateContext = createContext<DesktopUpdateContextValue | null>(null);
const startupCheckedPlatforms = new WeakSet<PlatformApi>();

export function useDesktopUpdate(): DesktopUpdateContextValue {
  const value = useContext(DesktopUpdateContext);
  if (!value) throw new Error("DesktopUpdateProvider is not configured");
  return value;
}

function updateFailureMessage(stage: "check" | "install"): string {
  return stage === "check"
    ? "检查更新失败，请稍后重试"
    : "更新下载或安装失败，当前版本未被替换，请重试";
}

export function DesktopUpdateProvider(props: {
  platform: PlatformApi;
  hasUnsaved: boolean;
  onBusyChange: (busy: boolean) => void;
  children: ReactNode;
}) {
  const { platform, hasUnsaved, onBusyChange, children } = props;
  const supported = hasCapability(platform, "app-update");
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<DesktopUpdateInfo | null>(null);
  const [checkStatus, setCheckStatus] = useState<DesktopUpdateCheckStatus>("idle");
  const [installState, setInstallState] = useState(INITIAL_DESKTOP_UPDATE_DOWNLOAD);
  const [error, setError] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const busy = installState.stage !== "idle";

  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void platform.appUpdate
      .currentVersion()
      .then((version) => {
        if (!cancelled) setCurrentVersion(version);
      })
      .catch(() => {
        // 当前版本只用于展示；读取失败不能影响登录或工作台。
      });
    return () => {
      cancelled = true;
    };
  }, [platform, supported]);

  const check = useCallback(
    async (manual = true) => {
      if (!supported || checkStatus === "checking" || busy) return;
      startupCheckedPlatforms.add(platform);
      setCheckStatus("checking");
      setError(null);
      try {
        const update = await platform.appUpdate.check();
        if (!update) {
          setAvailableUpdate(null);
          setCheckStatus("current");
          return;
        }
        setCurrentVersion(update.currentVersion);
        setAvailableUpdate(update);
        setCheckStatus("available");
        setPromptOpen(true);
      } catch {
        setCheckStatus("error");
        setError(updateFailureMessage("check"));
        if (!manual) setPromptOpen(false);
      }
    },
    [busy, checkStatus, platform, supported],
  );

  useEffect(() => {
    if (!supported || startupCheckedPlatforms.has(platform)) return;
    const timer = window.setTimeout(() => {
      if (startupCheckedPlatforms.has(platform)) return;
      void check(false);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [check, platform, supported]);

  const install = async () => {
    if (!availableUpdate || busy) return;
    if (hasUnsaved) {
      setError("请先保存所有未保存文件，再安装更新");
      return;
    }
    setError(null);
    setInstallState(PREPARING_DESKTOP_UPDATE_DOWNLOAD);
    try {
      await platform.appUpdate.install((progress) => {
        setInstallState((state) => applyDesktopUpdateProgress(state, progress));
      });
    } catch {
      setInstallState(INITIAL_DESKTOP_UPDATE_DOWNLOAD);
      setError(updateFailureMessage("install"));
      setCheckStatus("available");
    }
  };

  const value = useMemo<DesktopUpdateContextValue>(
    () => ({
      supported,
      currentVersion,
      availableUpdate,
      checkStatus,
      installState,
      error,
      check: () => check(true),
      showAvailable: () => availableUpdate && setPromptOpen(true),
    }),
    [availableUpdate, check, checkStatus, currentVersion, error, installState, supported],
  );
  const percent = desktopUpdateProgressPercent(installState);
  const indeterminate = installState.stage === "downloading" && percent === null;
  const progressText =
    installState.stage === "installing"
      ? "下载完成，正在安装并准备重启…"
      : installState.stage === "preparing"
        ? "正在准备下载…"
        : installState.totalBytes
          ? `已下载 ${formatDesktopUpdateBytes(installState.downloadedBytes)} / ${formatDesktopUpdateBytes(installState.totalBytes)}`
          : `已下载 ${formatDesktopUpdateBytes(installState.downloadedBytes)}`;

  return (
    <DesktopUpdateContext.Provider value={value}>
      {children}
      <Dialog
        open={promptOpen && availableUpdate !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPromptOpen(false);
        }}
      >
        <DialogContent
          className="max-w-md border-zinc-800 bg-zinc-900 text-xs text-zinc-100"
          showCloseButton={!busy}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">
              {busy ? "正在更新人人Codex" : `发现新版本 ${availableUpdate?.version ?? ""}`}
            </DialogTitle>
            <DialogDescription className="space-y-2 text-xs text-zinc-400">
              <span className="block">
                当前版本 {availableUpdate?.currentVersion ?? currentVersion ?? "未知"}
              </span>
              {!busy && availableUpdate?.notes && (
                <span className="block max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950/60 p-3 text-zinc-300">
                  {availableUpdate.notes}
                </span>
              )}
              {hasUnsaved && !busy && (
                <span className="block text-amber-400">请先保存所有未保存文件，再安装更新。</span>
              )}
              {error && <span className="block text-red-400">{error}</span>}
              {busy && (
                <span className="block space-y-2">
                  <span className="block">{progressText}</span>
                  <span
                    role="progressbar"
                    aria-label="客户端更新进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent ?? undefined}
                    aria-valuetext={progressText}
                    className="block h-1.5 overflow-hidden rounded-full bg-zinc-800"
                  >
                    <span
                      className={`block h-full rounded-full bg-[var(--cm-accent)] ${indeterminate ? "cm-progress-indeterminate" : "transition-[width] motion-reduce:transition-none"}`}
                      style={indeterminate ? undefined : { width: `${percent ?? 0}%` }}
                    />
                  </span>
                  <span className="block text-zinc-500">更新期间请不要关闭客户端。</span>
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {!busy && (
            <DialogFooter className="border-zinc-800 bg-zinc-950/40">
              <Button
                variant="outline"
                size="xs"
                className="cm-update-action cm-update-action-outline"
                onClick={() => setPromptOpen(false)}
              >
                稍后
              </Button>
              <Button
                size="xs"
                className="cm-update-action cm-update-action-primary"
                disabled={hasUnsaved}
                onClick={() => void install()}
              >
                立即更新
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </DesktopUpdateContext.Provider>
  );
}
