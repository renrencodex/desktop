import type { DesktopUpdateProgress } from "@cloud-machine/platform-api";

export type DesktopUpdateInstallStage = "idle" | "preparing" | "downloading" | "installing";

export interface DesktopUpdateDownloadState {
  downloadedBytes: number;
  totalBytes: number | null;
  stage: DesktopUpdateInstallStage;
}

export const INITIAL_DESKTOP_UPDATE_DOWNLOAD: DesktopUpdateDownloadState = {
  downloadedBytes: 0,
  totalBytes: null,
  stage: "idle",
};

export const PREPARING_DESKTOP_UPDATE_DOWNLOAD: DesktopUpdateDownloadState = {
  ...INITIAL_DESKTOP_UPDATE_DOWNLOAD,
  stage: "preparing",
};

export function applyDesktopUpdateProgress(
  state: DesktopUpdateDownloadState,
  progress: DesktopUpdateProgress,
): DesktopUpdateDownloadState {
  switch (progress.event) {
    case "started":
      return {
        downloadedBytes: 0,
        totalBytes: progress.data.contentLength,
        stage: "downloading",
      };
    case "progress":
      return {
        ...state,
        downloadedBytes: state.downloadedBytes + progress.data.chunkLength,
        stage: "downloading",
      };
    case "downloaded":
    case "installing":
      return { ...state, stage: "installing" };
  }
}

export function desktopUpdateProgressPercent(state: DesktopUpdateDownloadState): number | null {
  if (state.stage === "preparing") return 0;
  if (state.stage === "installing") return 100;
  if (!state.totalBytes || state.totalBytes <= 0) return null;
  return Math.min(100, Math.max(0, (state.downloadedBytes / state.totalBytes) * 100));
}

export function formatDesktopUpdateBytes(value: number): string {
  if (value < 1024) return `${Math.max(0, Math.round(value))} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
