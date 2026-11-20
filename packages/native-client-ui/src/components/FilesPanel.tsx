/**
 * Cursor 风格文件控制器：左侧 Monaco、右侧目录树，多个资源管理器共享 RPC 与编辑缓冲区。
 *
 * - 数据面：MachineRpcClient（/machines/:id/rpc 通道，fs.* 方法）；
 * - 文件树懒加载目录；新建 / 重命名 / 删除（二次确认）/ 刷新；
 * - 点击文件 → 代码编辑或常用格式预览；受限分块读取，不支持的格式提供下载；
 * - 上传（多路二进制流 + 原子提交）/ 下载（独立二进制流 + 磁盘临时文件 + 断线续传）；
 * - 连接断开显示状态条 + 手动重连（token 刷新逻辑与终端一致）。
 *
 * 注意：本组件涉及 Monaco 与真实后端的部分未在无浏览器环境实测（见交付报告）。
 */
import {
  DEFAULT_WORKSPACE_PATH,
  FS_TEXT_MAX_BYTES,
  FS_UPLOAD_CLIENT_MAX_CONCURRENT,
  type FileSearchMatch,
} from "@cloud-machine/client-contracts";
import {
  FileSearchPanel,
  useWorkspaceFileSearch,
  searchMatchOffsets,
  type FileSearchReveal,
} from "@cloud-machine/workspace-ui/file-search";
import { FILE_DOWNLOAD_MAX_TRANSIENT_RETRIES } from "@cloud-machine/workspace-ui/binary-file-download";
import { useMachineFileWatch } from "@cloud-machine/workspace-ui/file-watch";
import { buildWorkspaceGitDecorations } from "@cloud-machine/workspace-ui/workspace-diff-tree";
import {
  captureFileScrollPosition,
  resolveFileScrollPosition,
  type FileScrollPosition,
} from "@cloud-machine/workspace-ui/file-scroll-position";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowUp,
  Copy,
  Eye,
  FilePlus2,
  FolderPlus,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  UploadIcon,
  WrapText,
  X,
} from "lucide-react";
import type { GroupImperativeHandle, PanelImperativeHandle } from "react-resizable-panels";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { WorkbenchTab } from "@cloud-machine/api-client";
import {
  FS_ERROR_ALREADY_EXISTS,
  FS_ERROR_FORBIDDEN,
  CMP_METHODS,
  fsResolveResultSchema,
  type FsStatResult,
} from "@cloud-machine/client-contracts";
import {
  collectLocalDropManifest,
  hasLocalFileItems,
  isFatalUploadTransportError,
  localFilesManifest,
  ConcurrentLocalUploadByteCounter,
  type LocalDropFailure,
  type LocalDropManifest,
} from "@cloud-machine/workspace-ui/local-file-drop";

import { api } from "../lib/api";
import {
  mkdir as mkdirRpc,
  readFileAll,
  FileReadLimitError,
  remove as removeRpc,
  rename as renameRpc,
  statFile,
  saveTextFile,
  writeFileAll,
} from "../lib/fs-client";
import { downloadMachineDirectory, downloadMachineFile } from "../lib/machine-download";
import { createMachineUploadSession } from "../lib/machine-upload";
import { createMachineSearchSocket } from "../lib/machine-search";
import { createMachineWatchSocket } from "../lib/machine-watch";
import {
  pathMatches,
  reconcileOwnedItems,
  remapItemsAfterMove,
  selectRetainedEditorItem,
  selectVisibleEditorItem,
} from "../lib/editor-tabs";
import {
  explorerUsesDrawer,
  explorerPanelLayout,
  scheduleExplorerPanelLayoutRestore,
} from "../lib/explorer-panel-layout";
import {
  baseName,
  breadcrumbs,
  formatBytes,
  isProbablyBinary,
  joinPath,
  languageForPath,
  normalizePath,
  parentPath,
  remapDirectoryNavigation,
  remapMovedPath,
  removeDirectoryNavigation,
  returnDirectory,
  visitDirectory,
  type DirectoryNavigationState,
} from "../lib/fs-utils";
import { MachineRpcError } from "../lib/machine-rpc";
import {
  previewFormat,
  isTextPreview,
  trimPreviewCache,
  MAX_TEXT_PREVIEW_BYTES,
  MAX_FILE_PREVIEW_BYTES,
  type PreviewFormat,
} from "../lib/file-preview";
import { useMachineRpc } from "../lib/use-machine-rpc";
import { userErrorMessage } from "../lib/user-error";
import { useBackDismiss, useResponsiveViewport } from "../lib/responsive";
import { getThemeDefinition } from "../lib/themes";
import { DEFAULT_EXPLORER_TREE_SIZE } from "../lib/workbench-tabs";
import { useThemeStore } from "../stores/theme";
import { useAuthStore } from "../stores/auth";
import { useWorkbenchStore } from "../stores/workbench";
import { ConfirmDialog } from "./ConfirmDialog";
import { FileTree } from "./FileTree";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./ui/resizable";

const FileEditor = lazy(() => import("./FileEditor").then((m) => ({ default: m.FileEditor })));
const FilePreview = lazy(() => import("./FilePreview").then((m) => ({ default: m.FilePreview })));

/** 超过该大小不进入编辑器（提示下载）。 */
const MAX_EDIT_BYTES = FS_TEXT_MAX_BYTES;
const FILE_WATCH_RECONCILE_RETRY_DELAYS_MS = [200, 500, 1_000] as const;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function waitForFileWatchDelay(delay: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: number | null = null;
    const finish = () => {
      if (timer !== null) window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = window.setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

type EditorTab =
  | {
      kind: "ready";
      path: string;
      savedContent: string;
      value: string;
      editRevision: number;
      saving: boolean;
      externalState?: "changed" | "deleted";
      sourceView: boolean;
      ownerExplorerIds: string[];
    }
  | {
      kind: "preview";
      path: string;
      bytes: Uint8Array;
      format: PreviewFormat;
      ownerExplorerIds: string[];
      externalState?: "changed" | "deleted";
    }
  | {
      kind: "readonly";
      path: string;
      reason: string;
      size: number;
      ownerExplorerIds: string[];
      externalState?: "changed" | "deleted";
    };

type ExplorerWorkbenchTab = Extract<WorkbenchTab, { type: "explorer" }>;

interface NameDialogState {
  mode: "newFile" | "newFolder" | "rename";
  /** rename 时为被改名路径；new* 时为目标目录。 */
  target: string;
  isDir: boolean;
  value: string;
  explorerId: string;
}

interface DeleteState {
  path: string;
  name: string;
  isDir: boolean;
}

interface MoveState {
  path: string;
  isDir: boolean;
  targetDir: string;
}

interface MoveConflictState extends MoveState {
  to: string;
}

type UploadProgress =
  | { phase: "scanning"; targetDir: string }
  | {
      phase: "uploading";
      targetDir: string;
      activePaths: string[];
      processedFiles: number;
      totalFiles: number;
      transferredBytes: number;
      totalBytes: number;
      failureCount: number;
    };

function uploadProgressPercent(progress: Extract<UploadProgress, { phase: "uploading" }>): number {
  const ratio =
    progress.totalBytes > 0
      ? progress.transferredBytes / progress.totalBytes
      : progress.totalFiles > 0
        ? progress.processedFiles / progress.totalFiles
        : 0;
  return Math.min(100, Math.max(0, Math.floor(ratio * 100)));
}

/** 先让 0% 状态完成一次绘制，后续宽度更新才能从进度条起点平滑过渡。 */
function waitForUploadProgressPaint(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    let fallback: number | null = null;
    let settled = false;
    const cleanup = () => {
      if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
      if (fallback !== null) window.clearTimeout(fallback);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = () => finish(signal.reason ?? new DOMException("上传已取消", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    fallback = window.setTimeout(() => finish(), 80);
    firstFrame = window.requestAnimationFrame(() => {
      firstFrame = null;
      secondFrame = window.requestAnimationFrame(() => {
        secondFrame = null;
        finish();
      });
    });
  });
}

interface DownloadProgress {
  operationId: number;
  kind: "file" | "directory";
  path: string;
  receivedBytes: number;
  totalBytes: number | null;
  processedEntries: number;
  sourceBytes: number;
  skippedEntries: number;
  retryAttempt: number;
  retryLimit: number;
}

export const FILE_DOWNLOAD_PROGRESS_RENDER_INTERVAL_MS = 100;
const DOWNLOAD_ALREADY_RUNNING_MESSAGE = "已有下载任务正在进行，请等待完成或取消后重试";

interface DownloadProgressThrottleOptions {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => number;
  cancelScheduled?: (timer: number) => void;
  intervalMs?: number;
}

/** 保留每块进度用于停滞判定，只限制 React 状态刷新频率并保证首帧/完成帧立即显示。 */
export function createDownloadProgressThrottle<T extends number | null>(
  render: (receivedBytes: number, totalBytes: T) => void,
  options: DownloadProgressThrottleOptions = {},
): { update: (receivedBytes: number, totalBytes: T) => void; cancel: () => void } {
  const now = options.now ?? (() => performance.now());
  const schedule =
    options.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const cancelScheduled = options.cancelScheduled ?? ((timer) => window.clearTimeout(timer));
  const intervalMs = options.intervalMs ?? FILE_DOWNLOAD_PROGRESS_RENDER_INTERVAL_MS;
  let lastRenderedAt = now();
  let scheduled: number | null = null;
  let pending: { receivedBytes: number; totalBytes: T } | null = null;

  const flush = () => {
    scheduled = null;
    if (!pending) return;
    const next = pending;
    pending = null;
    lastRenderedAt = now();
    render(next.receivedBytes, next.totalBytes);
  };
  const cancel = () => {
    if (scheduled !== null) cancelScheduled(scheduled);
    scheduled = null;
    pending = null;
  };
  const update = (receivedBytes: number, totalBytes: T) => {
    pending = { receivedBytes, totalBytes };
    const elapsed = Math.max(0, now() - lastRenderedAt);
    const immediate =
      receivedBytes === 0 ||
      (totalBytes !== null && receivedBytes >= totalBytes) ||
      elapsed >= intervalMs;
    if (immediate) {
      if (scheduled !== null) cancelScheduled(scheduled);
      flush();
      return;
    }
    if (scheduled === null) scheduled = schedule(flush, intervalMs - elapsed);
  };
  return { update, cancel };
}

interface ExplorerViewState extends DirectoryNavigationState {
  pathDraft: string;
  navigating: boolean;
}

function createExplorerViewState(rootPath: string): ExplorerViewState {
  const currentDir = normalizePath(rootPath);
  return { currentDir, backStack: [], pathDraft: currentDir, navigating: false };
}

export interface FileBufferStatus {
  dirty: boolean;
  saving: boolean;
  ownerExplorerIds: string[];
}

interface ActionNotice {
  message: string;
  openDownloadDirectory?: () => Promise<void>;
}

export function ActionNoticeBanner({
  notice,
  onDismiss,
  onOpenError,
}: {
  notice: ActionNotice;
  onDismiss: () => void;
  onOpenError: (error: unknown) => void;
}) {
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const openDirectory = notice.openDownloadDirectory;
  return (
    <div className="flex min-w-0 items-center gap-2 border-b px-3 py-1.5 text-xs cm-banner-warning">
      <span className="min-w-0 flex-1 truncate" title={notice.message}>
        {notice.message}
      </span>
      {openDirectory && (
        <button
          type="button"
          className="cm-link ml-auto shrink-0 underline underline-offset-2 disabled:cursor-wait disabled:opacity-60"
          disabled={opening}
          onClick={() => {
            if (openingRef.current) return;
            openingRef.current = true;
            setOpening(true);
            void openDirectory().then(
              () => {
                openingRef.current = false;
                setOpening(false);
              },
              (error: unknown) => {
                openingRef.current = false;
                setOpening(false);
                onOpenError(error);
              },
            );
          }}
        >
          打开目录
        </button>
      )}
      <button
        type="button"
        aria-label="关闭提示"
        title="关闭提示"
        className="cm-icon-button shrink-0"
        onClick={onDismiss}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

export function FilesPanel({
  machineId,
  workspaceId,
  rootPath = DEFAULT_WORKSPACE_PATH,
  statusKey,
  active,
  available,
  mobileTreeOpenRequest,
  explorers,
  activeExplorerId,
  onOpenFile,
  onTreeLayoutChange,
  onPathMoved,
  onPathRemoved,
  onFileStatusesChange,
  onBusyChange,
  onOpenDownloadDirectory,
}: {
  machineId: string;
  workspaceId?: string;
  rootPath?: string;
  statusKey: string;
  /** 工作台当前是否正在展示资源管理器。 */
  active: boolean;
  /** 电脑与 Workspace 已就绪；重新变为 true 时自动恢复 RPC 和目录树。 */
  available: boolean;
  /** 手机版点击底部“文件”入口时递增，用于主动展开目录抽屉。 */
  mobileTreeOpenRequest: number;
  explorers: ExplorerWorkbenchTab[];
  activeExplorerId: string | null;
  onOpenFile: (explorerId: string, path: string) => void;
  onTreeLayoutChange: (explorerId: string, treeSize: number, treeCollapsed: boolean) => void;
  onPathMoved: (from: string, to: string, directory: boolean, overwrite: boolean) => void;
  onPathRemoved: (
    path: string,
    directory: boolean,
    retainedSelection?: Readonly<{ explorerId: string; path: string }>,
  ) => void;
  onFileStatusesChange: (statuses: Record<string, FileBufferStatus>) => void;
  onBusyChange?: (busy: boolean) => void;
  /** Desktop 原生能力；Web 不提供时不展示“打开目录”。 */
  onOpenDownloadDirectory?: () => Promise<void>;
}) {
  const rpcEnabled = available && explorers.length > 0;
  const { rpc, connState, notice, connect } = useMachineRpc(machineId, rpcEnabled);
  const connected = connState === "connected";
  const queryClient = useQueryClient();
  const gitStatusEnabled = active && available && connected && Boolean(workspaceId);
  const workspaceDiffQuery = useQuery({
    queryKey: ["workspace-diff", workspaceId],
    queryFn: () => {
      if (!workspaceId) throw new Error("Workspace is unavailable");
      return api.workspaces.diff(workspaceId);
    },
    enabled: gitStatusEnabled,
    retry: false,
    staleTime: 0,
    refetchInterval: gitStatusEnabled ? 3_000 : false,
    refetchOnWindowFocus: gitStatusEnabled,
  });
  const gitDecorations = useMemo(
    () =>
      workspaceDiffQuery.data?.isGit
        ? buildWorkspaceGitDecorations(rootPath, workspaceDiffQuery.data.files)
        : {},
    [rootPath, workspaceDiffQuery.data],
  );
  const searchAccountId = useAuthStore((state) => state.user?.id ?? null);
  const [searchReveal, setSearchReveal] = useState<
    (FileSearchReveal & { explorerId: string }) | null
  >(null);
  const searchRevealRef = useRef(searchReveal);
  const nextSearchReveal = useRef(0);
  const [treeReveal, setTreeReveal] = useState<{
    id: number;
    path: string;
    explorerId: string;
    done?: boolean;
  } | null>(null);
  // 预热 Monaco chunk：布局恢复后几乎必然打开文件，避免编辑区等待懒加载。
  useEffect(() => {
    void import("./FileEditor");
  }, []);
  const setEditorStatus = useWorkbenchStore((state) => state.setEditorStatus);
  const editorStatusKey = statusKey;
  const { isPhone, isResolved: responsiveResolved } = useResponsiveViewport();

  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const [explorerTreeRoot, setExplorerTreeRoot] = useState<string | null>(null);
  const [rootFallbackNotice, setRootFallbackNotice] = useState(false);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [retainedEditorPath, setRetainedEditorPath] = useState<string | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [explorerStates, setExplorerStates] = useState<Record<string, ExplorerViewState>>({});
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  const handledMobileTreeOpenRequestRef = useRef(0);
  const [isNarrow, setIsNarrow] = useState(false);
  const search = useWorkspaceFileSearch({
    scopeKey: JSON.stringify([searchAccountId, machineId, workspaceId, statusKey]),
    machineId,
    workspaceId,
    activeExplorerId,
    explorerIds: explorers.map((explorer) => explorer.id),
    enabled:
      searchAccountId !== null &&
      active &&
      available &&
      connected &&
      (isNarrow
        ? mobileTreeOpen
        : !explorers.find((explorer) => explorer.id === activeExplorerId)?.treeCollapsed),
    createSocket: createMachineSearchSocket,
  });
  useLayoutEffect(() => {
    // An in-flight directory reveal must not activate a different/hidden explorer later.
    nextSearchReveal.current++;
  }, [active, available, activeExplorerId, machineId, workspaceId, searchAccountId]);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteState | null>(null);
  const [discardPath, setDiscardPath] = useState<string | null>(null);
  const [reloadPath, setReloadPath] = useState<string | null>(null);
  const [moveDialog, setMoveDialog] = useState<MoveState | null>(null);
  const [moveConflict, setMoveConflict] = useState<MoveConflictState | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [pathMutationBusy, setPathMutationBusy] = useState(false);
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const [download, setDownload] = useState<DownloadProgress | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetRef = useRef(normalizePath(rootPath));
  const uploadBusyRef = useRef(false);
  const uploadControllerRef = useRef<AbortController | null>(null);
  const uploadingPathsRef = useRef(new Set<string>());
  const downloadBusyRef = useRef(false);
  const downloadControllerRef = useRef<AbortController | null>(null);
  const downloadProgressCancelRef = useRef<(() => void) | null>(null);
  const nextDownloadOperationIdRef = useRef(0);
  const activeDownloadOperationIdRef = useRef<number | null>(null);
  const duplicateDownloadErrorOwnerRef = useRef<number | null>(null);
  const downloadRpcEnabledRef = useRef(rpcEnabled);
  const downloadRpcRef = useRef(rpc);
  const desktopGroupRef = useRef<GroupImperativeHandle | null>(null);
  const desktopTreePanelRef = useRef<PanelImperativeHandle | null>(null);
  const desktopGroupElementRef = useRef<HTMLDivElement | null>(null);
  const panelElementRef = useRef<HTMLDivElement | null>(null);
  const filesPanelGroupId = useId();
  const tabsRef = useRef<EditorTab[]>(tabs);
  const explorersRef = useRef(explorers);
  const onPathRemovedRef = useRef(onPathRemoved);
  const explorerStatesRef = useRef(explorerStates);
  const directoryNavigationRequestsRef = useRef(new Map<string, number>());
  const nextDirectoryNavigationRequestRef = useRef(0);
  const pathMutationBusyRef = useRef(false);
  const watchReconcileGenerationRef = useRef(0);
  const watchReadControllerRef = useRef<AbortController | null>(null);
  const uncertainSavePathsRef = useRef(new Set<string>());
  const activeRef = useRef(active);
  const fileReadRef = useRef<{
    path: string;
    explorerId: string;
    forceSource: boolean;
    controller: AbortController;
  } | null>(null);
  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);

  useLayoutEffect(() => {
    onPathRemovedRef.current = onPathRemoved;
  }, [onPathRemoved]);

  useLayoutEffect(() => {
    const rpcChanged = downloadRpcRef.current !== rpc;
    downloadRpcRef.current = rpc;
    downloadRpcEnabledRef.current = rpcEnabled;
    if (rpcEnabled && !rpcChanged) return;
    downloadProgressCancelRef.current?.();
    downloadControllerRef.current?.abort(new DOMException("下载所在的工作区已失活", "AbortError"));
  }, [rpc, rpcEnabled]);

  useEffect(
    () => () => {
      uploadControllerRef.current?.abort();
      downloadProgressCancelRef.current?.();
      downloadControllerRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (!active) return;
    const preventFileNavigation = (event: DragEvent) => {
      if (hasLocalFileItems(event.dataTransfer)) event.preventDefault();
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, [active]);

  useBackDismiss(
    active && isNarrow && mobileTreeOpen,
    useCallback(() => setMobileTreeOpen(false), []),
    `file-tree:${statusKey}`,
  );

  useEffect(() => {
    if (!active || !isPhone || mobileTreeOpenRequest <= handledMobileTreeOpenRequestRef.current)
      return;
    handledMobileTreeOpenRequestRef.current = mobileTreeOpenRequest;
    setMobileTreeOpen(true);
  }, [active, isPhone, mobileTreeOpenRequest]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    explorersRef.current = explorers;
  }, [explorers]);

  const updateTabs = useCallback((update: (current: EditorTab[]) => EditorTab[]) => {
    const next = update(tabsRef.current);
    tabsRef.current = next;
    setTabs(next);
    return next;
  }, []);

  const readResource = useCallback(
    async (path: string, maxBytes: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      const resolved = fsResolveResultSchema.parse(
        await rpc.call(CMP_METHODS.FS_RESOLVE, { path }),
      );
      signal.throwIfAborted();
      if (!resolved.exists || resolved.type === "directory")
        throw new Error("依赖资源不存在或不是文件");
      return readFileAll(rpc, resolved.canonicalPath, { maxBytes, signal });
    },
    [rpc],
  );

  const updateExplorerState = useCallback(
    (explorerId: string, update: (current: ExplorerViewState) => ExplorerViewState) => {
      setExplorerStates((states) => {
        const current = states[explorerId] ?? createExplorerViewState(rootPath);
        const next = update(current);
        if (next === current) return states;
        const nextStates = { ...states, [explorerId]: next };
        explorerStatesRef.current = nextStates;
        return nextStates;
      });
    },
    [rootPath],
  );

  useEffect(() => {
    let cancelled = false;
    if (!connected) return;

    void (async () => {
      try {
        const resolved = fsResolveResultSchema.parse(
          await rpc.call(CMP_METHODS.FS_RESOLVE, { path: "/" }),
        );
        if (cancelled) return;
        if (
          resolved.exists &&
          resolved.type === "directory" &&
          normalizePath(resolved.canonicalPath) === "/"
        ) {
          setExplorerTreeRoot("/");
          setRootFallbackNotice(false);
          return;
        }
      } catch (error) {
        if (cancelled) return;
        if (!(error instanceof MachineRpcError) || error.code !== FS_ERROR_FORBIDDEN) {
          // 瞬时 RPC 故障不降级；让目录树沿用原有轮询与重连恢复。
          setExplorerTreeRoot("/");
          setRootFallbackNotice(false);
          return;
        }
      }

      const fallbackPath = normalizePath(rootPath);
      setExplorerTreeRoot(fallbackPath);
      setRootFallbackNotice(true);
      setExplorerStates((states) => {
        const nextStates = { ...states };
        for (const explorer of explorersRef.current)
          nextStates[explorer.id] = createExplorerViewState(fallbackPath);
        explorerStatesRef.current = nextStates;
        return nextStates;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, rootPath, rpc]);

  const remapExplorerPaths = useCallback((from: string, to: string, directory: boolean) => {
    setExplorerStates((states) => {
      const nextStates = Object.fromEntries(
        Object.entries(states).map(([id, state]) => [
          id,
          (() => {
            const navigation = remapDirectoryNavigation(state, from, to, directory);
            return {
              ...state,
              ...navigation,
              pathDraft: navigation.currentDir,
            };
          })(),
        ]),
      );
      explorerStatesRef.current = nextStates;
      return nextStates;
    });
  }, []);

  const removeExplorerPaths = useCallback((path: string, directory: boolean) => {
    setExplorerStates((states) => {
      const nextStates = Object.fromEntries(
        Object.entries(states).map(([id, state]) => [
          id,
          (() => {
            const navigation = removeDirectoryNavigation(state, path, directory);
            return {
              ...state,
              ...navigation,
              pathDraft: navigation.currentDir,
            };
          })(),
        ]),
      );
      explorerStatesRef.current = nextStates;
      return nextStates;
    });
  }, []);

  const activeExplorer = explorers.find((explorer) => explorer.id === activeExplorerId) ?? null;
  const activeExplorerNavigating = activeExplorerId
    ? explorerStates[activeExplorerId]?.navigating === true
    : false;
  const activeExplorerTreeSize = activeExplorer?.treeSize;
  const activeExplorerTreeCollapsed = activeExplorer?.treeCollapsed;
  const [initialDesktopLayout] = useState(() => {
    const initialExplorer = activeExplorer ?? explorers[0] ?? null;
    return explorerPanelLayout(
      initialExplorer?.treeSize ?? DEFAULT_EXPLORER_TREE_SIZE,
      initialExplorer?.treeCollapsed ?? false,
    );
  });
  const activePath = activeExplorer?.activeFilePath ?? null;
  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;
  const readyTabs = tabs.filter(
    (tab): tab is Extract<EditorTab, { kind: "ready" }> => tab.kind === "ready",
  );
  const activeReadyTab = activeTab?.kind === "ready" ? activeTab : null;
  const retainedEditorTab = selectRetainedEditorItem(readyTabs, activeReadyTab, retainedEditorPath);
  const dirtyFileCount = tabs.filter(
    (tab) => tab.kind === "ready" && tab.value !== tab.savedContent,
  ).length;

  useEffect(
    () => setEditorStatus(editorStatusKey, activePath, tabs.length, dirtyFileCount),
    [activePath, dirtyFileCount, editorStatusKey, setEditorStatus, tabs.length],
  );
  useEffect(
    () => () => {
      useWorkbenchStore.getState().setEditorStatus(editorStatusKey, null, 0);
    },
    [editorStatusKey],
  );

  useEffect(() => {
    onFileStatusesChange(
      Object.fromEntries(
        tabs.map((tab) => [
          tab.path,
          {
            dirty: tab.kind === "ready" && tab.value !== tab.savedContent,
            saving: tab.kind === "ready" && tab.saving,
            ownerExplorerIds: tab.ownerExplorerIds,
          },
        ]),
      ),
    );
  }, [onFileStatusesChange, tabs]);

  const refreshTree = useCallback(() => {
    setRefreshSignal((n) => n + 1);
    if (workspaceId)
      void queryClient.invalidateQueries(
        { queryKey: ["workspace-diff", workspaceId] },
        { cancelRefetch: false },
      );
  }, [queryClient, workspaceId]);

  useEffect(() => {
    // 初次连接及关机后的重新连接都刷新已展开目录；编辑缓冲区保留在内存中。
    if (connState !== "connected") return;
    const timer = window.setTimeout(refreshTree, 0);
    return () => window.clearTimeout(timer);
  }, [connState, refreshTree]);

  const showError = useCallback((err: unknown, fallback: string) => {
    setActionNotice(null);
    if (err instanceof MachineRpcError && err.code === FS_ERROR_FORBIDDEN) {
      setActionError("没有权限访问该路径");
    } else if (err instanceof MachineRpcError && err.code === FS_ERROR_ALREADY_EXISTS) {
      setActionError("目标已存在，请换一个名称，或使用“移动到…”并确认覆盖");
    } else {
      setActionError(userErrorMessage(err, fallback));
    }
  }, []);

  const navigateDirectory = useCallback(
    async (explorerId: string, rawTarget: string, mode: "visit" | "back" = "visit") => {
      const target = rawTarget.trim();
      if (!target.startsWith("/")) {
        setActionError("请输入以 / 开头的绝对路径");
        return;
      }
      const requestId = ++nextDirectoryNavigationRequestRef.current;
      setTreeReveal(null);
      directoryNavigationRequestsRef.current.set(explorerId, requestId);
      updateExplorerState(explorerId, (state) => ({ ...state, navigating: true }));
      setActionError(null);
      try {
        const resolved = fsResolveResultSchema.parse(
          await rpc.call(CMP_METHODS.FS_RESOLVE, { path: target }),
        );
        if (directoryNavigationRequestsRef.current.get(explorerId) !== requestId) return;
        if (!resolved.exists) {
          setActionError("目录不存在");
          return;
        }
        if (resolved.type !== "directory") {
          setActionError("该路径不是文件夹");
          return;
        }
        const canonicalPath = normalizePath(resolved.canonicalPath);
        updateExplorerState(explorerId, (state) => {
          const navigation =
            mode === "back"
              ? { ...returnDirectory(state), currentDir: canonicalPath }
              : visitDirectory(state, canonicalPath);
          return {
            ...state,
            ...navigation,
            pathDraft: canonicalPath,
            navigating: false,
          };
        });
        refreshTree();
        return canonicalPath;
      } catch (err) {
        if (directoryNavigationRequestsRef.current.get(explorerId) === requestId) {
          showError(err, "无法访问该目录");
        }
      } finally {
        if (directoryNavigationRequestsRef.current.get(explorerId) === requestId) {
          updateExplorerState(explorerId, (state) =>
            state.navigating ? { ...state, navigating: false } : state,
          );
        }
      }
    },
    [refreshTree, rpc, showError, updateExplorerState],
  );

  const navigateBack = useCallback(
    (explorerId: string) => {
      const state = explorerStatesRef.current[explorerId] ?? createExplorerViewState(rootPath);
      const target = state.backStack.at(-1);
      if (target) void navigateDirectory(explorerId, target, "back");
    },
    [navigateDirectory, rootPath],
  );

  const navigateUp = useCallback(
    (explorerId: string) => {
      const state = explorerStatesRef.current[explorerId] ?? createExplorerViewState(rootPath);
      const target = parentPath(state.currentDir);
      if (target !== state.currentDir) void navigateDirectory(explorerId, target);
    },
    [navigateDirectory, rootPath],
  );

  useEffect(() => {
    if (!active || !activeExplorerId || !connected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.repeat ||
        nameDialog ||
        deleteTarget ||
        discardPath ||
        reloadPath ||
        moveDialog ||
        moveConflict
      )
        return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const navigationSurface = target.closest<HTMLElement>("[data-directory-navigation]");
      if (navigationSurface?.dataset.directoryNavigation !== activeExplorerId) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigateBack(activeExplorerId);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        navigateUp(activeExplorerId);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    active,
    activeExplorerId,
    connected,
    deleteTarget,
    discardPath,
    moveConflict,
    moveDialog,
    nameDialog,
    navigateBack,
    navigateUp,
    reloadPath,
  ]);

  // ---------------------------------------------------------------- 打开文件
  const openFile = useCallback(
    async (explorerId: string, path: string, force = false) => {
      if (pathMutationBusyRef.current) return;
      const forceSource =
        searchRevealRef.current?.path === path && searchRevealRef.current.explorerId === explorerId;
      if (
        fileReadRef.current?.path === path &&
        fileReadRef.current.explorerId === explorerId &&
        !fileReadRef.current.controller.signal.aborted &&
        // A content hit must supersede an in-flight preview read, including its larger limit.
        (!forceSource || fileReadRef.current.forceSource) &&
        !force
      )
        return;
      fileReadRef.current?.controller.abort();
      fileReadRef.current = null;
      const existing = tabsRef.current.find((tab) => tab.path === path);
      const reloadDeletedBuffer = existing?.externalState === "deleted";
      if (existing?.kind === "ready" && existing.saving && force) return;
      if (
        existing &&
        !force &&
        !reloadDeletedBuffer &&
        !(forceSource && existing.kind !== "ready")
      ) {
        if (existing.kind === "ready") setRetainedEditorPath(path);
        setOpeningPath((current) => (current === path ? null : current));
        updateTabs((current) => [
          ...current.filter((tab) => tab.path !== path),
          {
            ...existing,
            ownerExplorerIds: [...new Set([...existing.ownerExplorerIds, explorerId])],
          },
        ]);
        return;
      }
      const controller = new AbortController();
      fileReadRef.current = { path, explorerId, forceSource, controller };
      const selected = () =>
        !controller.signal.aborted &&
        explorersRef.current.some(
          (explorer) => explorer.id === explorerId && explorer.activeFilePath === path,
        );
      const commitTab = (candidate: EditorTab) => {
        if (!selected()) return false;
        let committed = false;
        updateTabs((current) => {
          const previous = current.find((tab) => tab.path === path);
          // 重载期间仍允许编辑；确认过的放弃修改只授权丢弃读取开始前的内容。
          // 版本也能识别编辑后撤销回原文，保存状态变化则不能被旧读取覆盖。
          if (
            existing?.kind === "ready" &&
            (previous?.kind !== "ready" ||
              previous.editRevision !== existing.editRevision ||
              previous.savedContent !== existing.savedContent ||
              previous.saving)
          ) {
            setActionError(
              "重新加载期间文件发生了本地修改或保存，已保留本地内容。请确认后重新加载",
            );
            return current;
          }
          const owners = [...new Set([...(previous?.ownerExplorerIds ?? []), explorerId])];
          const next = { ...candidate, ownerExplorerIds: owners };
          committed = true;
          return trimPreviewCache([...current.filter((tab) => tab.path !== path), next], path);
        });
        return committed;
      };
      setActionError(null);
      setOpeningPath(path);
      try {
        let st: FsStatResult | null = null;
        try {
          st = await statFile(rpc, path);
        } catch {
          st = null;
        }
        if (!selected()) return;
        if (st && !st.exists) {
          if (!existing) onPathRemovedRef.current(path, false);
          setActionError(`${baseName(path)}：文件已不存在`);
          return;
        }
        const guessed = previewFormat(path);
        const limit =
          !forceSource && guessed && !isTextPreview(guessed.kind)
            ? MAX_FILE_PREVIEW_BYTES
            : MAX_EDIT_BYTES;
        if (st && st.exists && st.type === "file" && (st.size ?? 0) > limit) {
          const tab: EditorTab = {
            kind: "readonly",
            path,
            reason: `文件大小 ${formatBytes(st.size ?? 0)} 超过${limit === MAX_FILE_PREVIEW_BYTES ? "预览" : "编辑"}上限 ${formatBytes(limit)}`,
            size: st.size ?? 0,
            ownerExplorerIds: [explorerId],
          };
          commitTab(tab);
          return;
        }
        const bytes = await readFileAll(rpc, path, { maxBytes: limit, signal: controller.signal });
        if (!selected()) return;
        const format = previewFormat(path, bytes);
        if (!forceSource && format && !isTextPreview(format.kind)) {
          commitTab({ kind: "preview", path, bytes, format, ownerExplorerIds: [explorerId] });
          return;
        }
        if (isProbablyBinary(bytes)) {
          const tab: EditorTab = {
            kind: "readonly",
            path,
            reason: "疑似二进制文件（含 NUL 字节），不可文本编辑",
            size: bytes.length,
            ownerExplorerIds: [explorerId],
          };
          commitTab(tab);
          return;
        }
        const content = new TextDecoder().decode(bytes);
        const committed = commitTab({
          kind: "ready",
          path,
          savedContent: content,
          value: content,
          editRevision: existing?.kind === "ready" ? existing.editRevision + 1 : 0,
          saving: false,
          ownerExplorerIds: [explorerId],
          sourceView:
            forceSource ||
            (existing?.kind === "ready" ? existing.sourceView : format?.kind === "html"),
        });
        if (committed) setRetainedEditorPath(path);
      } catch (err) {
        if (!selected()) return;
        if (err instanceof FileReadLimitError) {
          commitTab({
            kind: "readonly",
            path,
            reason: `文件大小 ${formatBytes(err.size)} 超过读取上限 ${formatBytes(err.limit)}`,
            size: err.size,
            ownerExplorerIds: [explorerId],
          });
          return;
        }
        // 只读打开可安全重试：useMachineRpc 重连成功后 connState 变化会重新触发
        // 当前 activePath 的 openFile，避免把瞬时 WebSocket 断线误报成文件错误。
        if (err instanceof MachineRpcError && err.code === "RPC_CLOSED") return;
        setActionError(`${baseName(path)}：${userErrorMessage(err, "读取失败")}`);
      } finally {
        if (fileReadRef.current?.controller === controller) {
          fileReadRef.current = null;
          setOpeningPath((current) => (current === path ? null : current));
        }
      }
    },
    [rpc, updateTabs],
  );

  const selectFile = useCallback(
    (explorerId: string, path: string) => {
      nextSearchReveal.current++;
      setTreeReveal(null);
      setOpeningPath(path);
      onOpenFile(explorerId, path);
    },
    [onOpenFile],
  );

  const openSearchResult = (explorerId: string, searchRoot: string, match: FileSearchMatch) => {
    setTreeReveal(null);
    const path = joinPath(searchRoot, match.path);
    const request =
      match.kind === "content" ? { id: ++nextSearchReveal.current, path, match, explorerId } : null;
    searchRevealRef.current = request;
    setSearchReveal(request);
    if (request)
      updateTabs((items) =>
        items.map((tab) =>
          tab.path === path && tab.kind === "ready" ? { ...tab, sourceView: true } : tab,
        ),
      );
    selectFile(explorerId, path);
    if (
      explorersRef.current.find((explorer) => explorer.id === explorerId)?.activeFilePath === path
    )
      void openFile(explorerId, path);
    if (isNarrow) setMobileTreeOpen(false);
  };

  const revealSearchResult = async (
    explorerId: string,
    searchRoot: string,
    match: FileSearchMatch,
  ) => {
    const requestId = ++nextSearchReveal.current;
    const path = joinPath(searchRoot, match.path);
    const state = explorerStatesRef.current[explorerId] ?? createExplorerViewState(rootPath);
    if (!path.startsWith(`${state.currentDir === "/" ? "" : state.currentDir}/`)) {
      if (!(await navigateDirectory(explorerId, searchRoot))) return;
    }
    if (requestId !== nextSearchReveal.current || !activeRef.current) return;
    search.setView(explorerId, "tree");
    setTreeReveal({ id: requestId, path, explorerId });
  };

  useEffect(() => {
    // 不用 requestAnimationFrame：页面静态时帧产出可能被推迟数秒（e2e headless 实测），
    // 导致布局恢复后的自动打开迟迟不发生。
    if (!activeExplorerId || !activePath || connState !== "connected") return;
    const timer = window.setTimeout(() => void openFile(activeExplorerId, activePath), 0);
    return () => {
      window.clearTimeout(timer);
      fileReadRef.current?.controller.abort();
      fileReadRef.current = null;
    };
  }, [activeExplorerId, activePath, connState, openFile]);

  const reloadFile = (path: string) => {
    const tab = tabsRef.current.find((item) => item.path === path);
    if (tab?.kind === "ready" && tab.saving) return;
    if (tab?.kind === "ready" && tab.value !== tab.savedContent) setReloadPath(path);
    else if (activeExplorerId) void openFile(activeExplorerId, path, true);
  };

  const reconcileWatchedFile = useCallback(() => {
    const path = activePath;
    const explorerId = activeExplorerId;
    if (!path || !explorerId) return;
    const generation = ++watchReconcileGenerationRef.current;
    watchReadControllerRef.current?.abort();
    const controller = new AbortController();
    watchReadControllerRef.current = controller;
    const currentSelection = () =>
      !controller.signal.aborted &&
      generation === watchReconcileGenerationRef.current &&
      activeRef.current &&
      explorersRef.current.find((explorer) => explorer.id === explorerId)?.activeFilePath === path;
    const setExternalState = (state: EditorTab["externalState"]) => {
      if (!currentSelection()) return;
      updateTabs((items) =>
        items.map((item) =>
          item.path === path && item.externalState !== state
            ? { ...item, externalState: state }
            : item,
        ),
      );
    };
    const waitForSave = async () => {
      await waitForFileWatchDelay(100, controller.signal);
      controller.signal.throwIfAborted();
    };
    const reconcileOnce = async () => {
      for (;;) {
        if (!currentSelection()) return;
        const snapshot = tabsRef.current.find((item) => item.path === path);
        if (!snapshot) return;
        if (snapshot.kind === "ready" && snapshot.saving) {
          await waitForSave();
          continue;
        }
        const stat = await statFile(rpc, path, controller.signal);
        if (!currentSelection()) return;
        if (!stat.exists || stat.type !== "file") {
          uncertainSavePathsRef.current.delete(path);
          setExternalState("deleted");
          refreshTree();
          return;
        }

        if (snapshot.kind === "ready") {
          let bytes: Uint8Array;
          try {
            bytes = await readFileAll(rpc, path, {
              maxBytes: MAX_EDIT_BYTES,
              signal: controller.signal,
            });
          } catch (error) {
            if (!(error instanceof FileReadLimitError)) throw error;
            const latest = tabsRef.current.find((item) => item.path === path);
            if (!currentSelection() || latest?.kind !== "ready") return;
            if (latest.saving || latest.savedContent !== snapshot.savedContent) {
              await waitForSave();
              continue;
            }
            if (latest.value !== latest.savedContent) setExternalState("changed");
            else await openFile(explorerId, path, true);
            refreshTree();
            return;
          }
          if (!currentSelection()) return;
          const latest = tabsRef.current.find((item) => item.path === path);
          if (latest?.kind !== "ready") return;
          if (latest.saving || latest.savedContent !== snapshot.savedContent) {
            await waitForSave();
            continue;
          }
          if (isProbablyBinary(bytes)) {
            if (latest.value !== latest.savedContent) setExternalState("changed");
            else await openFile(explorerId, path, true);
            refreshTree();
            return;
          }
          const remote = new TextDecoder().decode(bytes);
          if (remote === latest.savedContent) {
            uncertainSavePathsRef.current.delete(path);
            setExternalState(undefined);
            return;
          }
          // fs.write may have committed immediately before its RPC reply was lost. If disk now
          // equals the local buffer, advance the saved baseline instead of reporting a conflict
          // or forcing a duplicate write. Any edits made while this read was in flight stay dirty.
          if (remote === latest.value) {
            const confirmedUncertainSave = uncertainSavePathsRef.current.delete(path);
            updateTabs((items) =>
              items.map((item) =>
                item.path === path &&
                item.kind === "ready" &&
                !item.saving &&
                item.savedContent === latest.savedContent
                  ? { ...item, savedContent: remote, externalState: undefined }
                  : item,
              ),
            );
            if (confirmedUncertainSave) setActionError(null);
            refreshTree();
            return;
          }
          if (latest.value !== latest.savedContent) {
            uncertainSavePathsRef.current.delete(path);
            setExternalState("changed");
            refreshTree();
            return;
          }
          uncertainSavePathsRef.current.delete(path);
          let replaced = false;
          updateTabs((items) =>
            items.map((item) => {
              if (
                item.path !== path ||
                item.kind !== "ready" ||
                item.saving ||
                item.savedContent !== latest.savedContent ||
                item.editRevision !== latest.editRevision
              )
                return item;
              if (item.value !== item.savedContent)
                return { ...item, externalState: "changed" as const };
              replaced = true;
              return {
                ...item,
                savedContent: remote,
                value: remote,
                editRevision: item.editRevision + 1,
                externalState: undefined,
              };
            }),
          );
          if (!replaced) setExternalState("changed");
          refreshTree();
          return;
        }

        if (snapshot.kind === "preview") {
          let bytes: Uint8Array;
          try {
            bytes = await readFileAll(rpc, path, {
              maxBytes: MAX_FILE_PREVIEW_BYTES,
              signal: controller.signal,
            });
          } catch (error) {
            if (!(error instanceof FileReadLimitError)) throw error;
            await openFile(explorerId, path, true);
            refreshTree();
            return;
          }
          if (!currentSelection()) return;
          const latest = tabsRef.current.find((item) => item.path === path);
          if (latest?.kind !== "preview") return;
          if (bytesEqual(bytes, latest.bytes)) setExternalState(undefined);
          else {
            await openFile(explorerId, path, true);
            refreshTree();
          }
          return;
        }

        await openFile(explorerId, path, true);
        refreshTree();
        return;
      }
    };
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await reconcileOnce();
          return;
        } catch (error) {
          if (
            controller.signal.aborted ||
            (error instanceof MachineRpcError && error.code === "RPC_CLOSED")
          )
            return;
          const delay = FILE_WATCH_RECONCILE_RETRY_DELAYS_MS[attempt];
          if (delay === undefined) return;
          // Watch messages invalidate a cache. Preserve the current buffer while retrying a
          // bounded number of transient stat/read failures, then wait for the next resync.
          await waitForFileWatchDelay(delay, controller.signal);
        }
      }
    })();
  }, [activeExplorerId, activePath, openFile, refreshTree, rpc, updateTabs]);

  useMachineFileWatch({
    machineId,
    path: activePath,
    enabled: active && available && connected && activeTab !== null && !pathMutationBusy,
    createSocket: createMachineWatchSocket,
    onInvalidate: reconcileWatchedFile,
  });

  useEffect(
    () => () => {
      watchReconcileGenerationRef.current++;
      watchReadControllerRef.current?.abort();
      watchReadControllerRef.current = null;
    },
    [active, activePath, available, connected, machineId, pathMutationBusy, rpc],
  );

  useEffect(() => {
    const explorerIds = new Set(explorers.map((explorer) => explorer.id));
    const activePaths = new Set(
      explorers.flatMap((explorer) => (explorer.activeFilePath ? [explorer.activeFilePath] : [])),
    );
    const nextTabs = reconcileOwnedItems(tabsRef.current, explorerIds).filter(
      (tab) => tab.externalState !== "deleted" || activePaths.has(tab.path),
    );
    if (
      nextTabs.length !== tabsRef.current.length ||
      nextTabs.some((tab, index) => tab !== tabsRef.current[index])
    ) {
      updateTabs(() => nextTabs);
    }
  }, [explorers, updateTabs]);

  // ---------------------------------------------------------------- 保存
  const saveFile = useCallback(
    async (path?: string) => {
      const targetPath = path ?? activePath;
      if (targetPath && uploadingPathsRef.current.has(targetPath)) {
        setActionError("该文件正在上传，请等待上传完成后再保存");
        return;
      }
      if (pathMutationBusyRef.current) {
        setActionError("文件路径正在变更，请等待操作完成后再保存");
        return;
      }
      const current = tabsRef.current.find((tab) => tab.path === targetPath);
      if (
        !targetPath ||
        !current ||
        current.kind !== "ready" ||
        current.saving ||
        current.value === current.savedContent
      ) {
        return;
      }
      if (current.externalState) {
        setActionError(
          current.externalState === "deleted"
            ? "文件已删除，请复制当前只读内容或重新创建文件后再打开"
            : "文件已在外部修改，请复制本地内容并重新加载后再保存",
        );
        return;
      }
      updateTabs((items) =>
        items.map((tab) =>
          tab.path === targetPath && tab.kind === "ready" ? { ...tab, saving: true } : tab,
        ),
      );
      try {
        await saveTextFile(rpc, targetPath, current.value, current.savedContent);
        uncertainSavePathsRef.current.delete(targetPath);
        updateTabs((items) =>
          items.map((tab) =>
            tab.path === targetPath && tab.kind === "ready"
              ? { ...tab, savedContent: current.value, saving: false, externalState: undefined }
              : tab,
          ),
        );
        setActionError(null);
        refreshTree();
      } catch (err) {
        if (
          err instanceof MachineRpcError &&
          (err.code === "RPC_CLOSED" || err.code === "RPC_TIMEOUT")
        )
          uncertainSavePathsRef.current.add(targetPath);
        else uncertainSavePathsRef.current.delete(targetPath);
        updateTabs((items) =>
          items.map((tab) =>
            tab.path === targetPath && tab.kind === "ready" ? { ...tab, saving: false } : tab,
          ),
        );
        showError(err, "保存失败");
      }
    },
    [activePath, rpc, refreshTree, showError, updateTabs],
  );

  useEffect(() => {
    onBusyChange?.(
      pathMutationBusy ||
        upload !== null ||
        download !== null ||
        tabs.some((tab) => tab.kind === "ready" && tab.saving),
    );
  }, [download, onBusyChange, pathMutationBusy, upload, tabs]);

  const downloadFile = useCallback(
    async (path: string, kind: "file" | "directory" = "file") => {
      if (downloadBusyRef.current) {
        const owner = activeDownloadOperationIdRef.current;
        if (owner !== null) duplicateDownloadErrorOwnerRef.current = owner;
        setActionError(DOWNLOAD_ALREADY_RUNNING_MESSAGE);
        return;
      }
      if (uploadBusyRef.current) {
        setActionError("正在上传文件，请等待完成或取消后再下载");
        return;
      }
      if (!available) {
        setActionError("电脑尚未就绪，请稍后重试");
        return;
      }
      const operationId = ++nextDownloadOperationIdRef.current;
      const controller = new AbortController();
      activeDownloadOperationIdRef.current = operationId;
      downloadBusyRef.current = true;
      downloadControllerRef.current = controller;
      const ensureDownloadScope = () => {
        controller.signal.throwIfAborted();
        if (downloadRpcEnabledRef.current && downloadRpcRef.current === rpc) return;
        if (!controller.signal.aborted)
          controller.abort(new DOMException("下载所在的工作区已失活", "AbortError"));
        controller.signal.throwIfAborted();
      };
      const progress = createDownloadProgressThrottle((receivedBytes, totalBytes) =>
        setDownload((current) =>
          current?.operationId === operationId
            ? { ...current, receivedBytes, totalBytes, retryAttempt: 0 }
            : current,
        ),
      );
      downloadProgressCancelRef.current = progress.cancel;
      const fileName =
        kind === "directory"
          ? `${normalizePath(path) === "/" ? "root" : baseName(path)}.zip`
          : baseName(path);
      setActionError(null);
      setActionNotice(null);
      setDownload({
        operationId,
        kind,
        path,
        receivedBytes: 0,
        totalBytes: kind === "directory" ? null : 0,
        processedEntries: 0,
        sourceBytes: 0,
        skippedEntries: 0,
        retryAttempt: 0,
        retryLimit: FILE_DOWNLOAD_MAX_TRANSIENT_RETRIES,
      });
      try {
        ensureDownloadScope();
        const commonOptions = {
          signal: controller.signal,
          onProgress: progress.update,
          onRetry: (_error: unknown, retryAttempt: number, retryLimit: number) => {
            ensureDownloadScope();
            if (kind === "directory") progress.cancel();
            setDownload((current) =>
              current?.operationId === operationId
                ? {
                    ...current,
                    receivedBytes: kind === "directory" ? 0 : current.receivedBytes,
                    processedEntries: kind === "directory" ? 0 : current.processedEntries,
                    sourceBytes: kind === "directory" ? 0 : current.sourceBytes,
                    skippedEntries: kind === "directory" ? 0 : current.skippedEntries,
                    retryAttempt,
                    retryLimit,
                  }
                : current,
            );
            ensureDownloadScope();
          },
        };
        const result =
          kind === "directory"
            ? await downloadMachineDirectory(machineId, path, fileName, {
                ...commonOptions,
                onArchiveProgress: (archiveProgress) =>
                  setDownload((current) =>
                    current?.operationId === operationId
                      ? { ...current, ...archiveProgress }
                      : current,
                  ),
              })
            : await downloadMachineFile(machineId, path, fileName, commonOptions);
        ensureDownloadScope();
        controller.signal.throwIfAborted();
        setActionNotice({
          message:
            kind === "directory" && typeof result !== "number"
              ? `下载完成：${fileName}（${formatBytes(result.size)}）${result.skippedEntries > 0 ? `，已跳过 ${result.skippedEntries} 个特殊条目` : ""}`
              : `下载完成：${fileName}（${formatBytes(result as number)}）`,
          openDownloadDirectory: onOpenDownloadDirectory,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          setActionNotice({ message: `下载已取消：${fileName}` });
        } else {
          showError(err, "下载失败");
        }
      } finally {
        progress.cancel();
        if (downloadProgressCancelRef.current === progress.cancel)
          downloadProgressCancelRef.current = null;
        if (activeDownloadOperationIdRef.current === operationId) {
          activeDownloadOperationIdRef.current = null;
          downloadBusyRef.current = false;
          if (downloadControllerRef.current === controller) downloadControllerRef.current = null;
          setDownload((current) => (current?.operationId === operationId ? null : current));
        }
        if (duplicateDownloadErrorOwnerRef.current === operationId) {
          duplicateDownloadErrorOwnerRef.current = null;
          setActionError((current) =>
            current === DOWNLOAD_ALREADY_RUNNING_MESSAGE ? null : current,
          );
        }
      }
    },
    [available, machineId, onOpenDownloadDirectory, rpc, showError],
  );

  const moveEntry = async (path: string, targetDir: string, isDir: boolean, overwrite = false) => {
    if (uploadBusyRef.current) {
      setActionError("正在上传文件，请等待完成或取消后再移动");
      return;
    }
    const trimmedTarget = targetDir.trim();
    if (!trimmedTarget.startsWith("/")) {
      setActionError("请输入以 / 开头的绝对目录路径");
      return;
    }
    const normalizedTarget = normalizePath(trimmedTarget);
    const to = joinPath(normalizedTarget, baseName(path));
    if (to === path || (isDir && to.startsWith(`${path}/`))) return;
    const savingConflict = tabsRef.current.some(
      (tab) =>
        tab.kind === "ready" &&
        tab.saving &&
        (pathMatches(tab.path, path, isDir) || pathMatches(tab.path, to, isDir)),
    );
    if (savingConflict) {
      setActionError("文件仍在保存中，请等待保存完成后再移动");
      return;
    }
    if (pathMutationBusyRef.current) {
      setActionError("另一个文件路径操作仍在进行，请稍后重试");
      return;
    }
    pathMutationBusyRef.current = true;
    setPathMutationBusy(true);
    fileReadRef.current?.controller.abort();
    setActionError(null);
    setMoveBusy(true);
    try {
      await renameRpc(rpc, path, to, overwrite);
      updateTabs((items) => remapItemsAfterMove(items, path, to, isDir, overwrite));
      remapExplorerPaths(path, to, isDir);
      setMoveDialog(null);
      setMoveConflict(null);
      onPathMoved(path, to, isDir, overwrite);
      refreshTree();
    } catch (err) {
      if (err instanceof MachineRpcError && err.code === FS_ERROR_ALREADY_EXISTS && !overwrite) {
        setMoveDialog(null);
        setMoveConflict({ path, targetDir: normalizedTarget, isDir, to });
      } else {
        showError(err, "移动失败");
      }
    } finally {
      pathMutationBusyRef.current = false;
      setPathMutationBusy(false);
      setMoveBusy(false);
    }
  };

  // ---------------------------------------------------------------- 上传
  const startUpload = async (
    rawTargetDir: string,
    collect: (signal: AbortSignal) => LocalDropManifest | Promise<LocalDropManifest>,
  ) => {
    if (downloadBusyRef.current) {
      setActionError("正在下载文件，请等待完成或取消后再上传");
      return;
    }
    if (uploadBusyRef.current) {
      setActionError("已有上传任务正在进行，请等待完成或取消后重试");
      return;
    }
    if (pathMutationBusyRef.current) {
      setActionError("文件路径正在变更，请等待操作完成后再上传");
      return;
    }
    if (!connected) {
      setActionError(connectionActionMessage);
      return;
    }
    const targetDir = normalizePath(rawTargetDir);
    const controller = new AbortController();
    uploadBusyRef.current = true;
    uploadControllerRef.current = controller;
    setActionError(null);
    setActionNotice(null);
    setUpload({ phase: "scanning", targetDir });

    let succeededFiles = 0;
    let processedFiles = 0;
    const transferredBytes = new ConcurrentLocalUploadByteCounter();
    let totalFiles = 0;
    let failures: LocalDropFailure[] = [];

    try {
      const manifest = await collect(controller.signal);
      controller.signal.throwIfAborted();
      failures = [...manifest.failures];
      totalFiles = manifest.files.length;
      const totalBytes = manifest.files.reduce((total, item) => total + item.file.size, 0);
      if (!manifest.directoryEntriesSupported) {
        setActionNotice({ message: "当前浏览器不支持目录拖放，本次仅处理浏览器提供的普通文件" });
      }
      if (manifest.directories.length === 0 && totalFiles === 0) {
        if (failures.length === 0) setActionError("拖入内容中没有可上传的文件或目录");
        else {
          const first = failures[0]!;
          setActionError(`没有可上传的项目。${first.relativePath}：${first.message}`);
        }
        return;
      }

      const failedDirectories: string[] = [];
      for (const relativePath of manifest.directories) {
        controller.signal.throwIfAborted();
        if (
          failedDirectories.some(
            (parent) => relativePath === parent || relativePath.startsWith(`${parent}/`),
          )
        )
          continue;
        try {
          await mkdirRpc(rpc, joinPath(targetDir, relativePath));
        } catch (error) {
          if (isFatalUploadTransportError(error)) throw error;
          failures.push({
            relativePath,
            message: userErrorMessage(error, "创建远端目录失败"),
          });
          failedDirectories.push(relativePath);
        }
      }

      const pendingTargetPaths = new Set<string>();
      const pendingFiles = manifest.files.flatMap((item, index) => {
        const targetPath = joinPath(targetDir, item.relativePath);
        const failedParent = failedDirectories.find((parent) =>
          item.relativePath.startsWith(`${parent}/`),
        );
        if (failedParent) {
          failures.push({
            relativePath: item.relativePath,
            message: `父目录 ${failedParent} 创建失败`,
          });
          processedFiles++;
          return [];
        }
        const conflictingEditor = tabsRef.current.find(
          (tab) =>
            tab.path === targetPath &&
            tab.kind === "ready" &&
            (tab.saving || tab.value !== tab.savedContent),
        );
        if (conflictingEditor) {
          failures.push({
            relativePath: item.relativePath,
            message: "目标文件在编辑器中有未保存修改或正在保存",
          });
          processedFiles++;
          return [];
        }
        if (pendingTargetPaths.has(targetPath)) {
          failures.push({
            relativePath: item.relativePath,
            message: "本批次中存在重复的目标路径",
          });
          processedFiles++;
          return [];
        }
        pendingTargetPaths.add(targetPath);
        return [{ item, targetPath, progressId: `${index}:${item.relativePath}` }];
      });

      if (pendingFiles.length > 0) {
        const activeRelativePaths = new Map<string, string>();
        const renderUploadProgress = (transferred: number, batchTotal: number) =>
          setUpload({
            phase: "uploading",
            targetDir,
            activePaths: [...activeRelativePaths.values()],
            processedFiles,
            totalFiles,
            transferredBytes: transferred,
            totalBytes: batchTotal,
            failureCount: failures.length,
          });
        const progress = createDownloadProgressThrottle(renderUploadProgress);
        setUpload({
          phase: "uploading",
          targetDir,
          activePaths: [],
          processedFiles,
          totalFiles,
          transferredBytes: 0,
          totalBytes,
          failureCount: failures.length,
        });
        await waitForUploadProgressPaint(controller.signal);
        const session = await createMachineUploadSession(machineId, controller.signal);
        let nextFile = 0;
        let fatalError: unknown | null = null;
        const worker = async () => {
          for (;;) {
            controller.signal.throwIfAborted();
            if (fatalError !== null) return;
            const work = pendingFiles[nextFile++];
            if (!work) return;
            const { item, targetPath, progressId } = work;
            uploadingPathsRef.current.add(targetPath);
            activeRelativePaths.set(targetPath, item.relativePath);
            progress.update(transferredBytes.value, totalBytes);
            try {
              await session.upload({
                path: targetPath,
                blob: item.file,
                signal: controller.signal,
                beforeCommit: () => {
                  const current = tabsRef.current.find((tab) => tab.path === targetPath);
                  if (
                    current?.kind === "ready" &&
                    (current.saving || current.value !== current.savedContent)
                  ) {
                    throw new Error("目标文件在上传期间产生了未保存修改");
                  }
                },
                onProgress: (written) => {
                  progress.update(
                    transferredBytes.recordFileProgress(progressId, written),
                    totalBytes,
                  );
                },
              });
              succeededFiles++;
              transferredBytes.recordFileProgress(progressId, item.file.size);

              const openTab = tabsRef.current.find((tab) => tab.path === targetPath);
              const selectedExplorer = explorersRef.current.find(
                (explorer) => explorer.activeFilePath === targetPath,
              );
              if (
                openTab?.kind === "ready" &&
                (openTab.saving || openTab.value !== openTab.savedContent)
              ) {
                failures.push({
                  relativePath: item.relativePath,
                  message: "上传已完成，但编辑器产生了本地修改，未自动重新加载",
                });
              } else {
                if (openTab)
                  updateTabs((current) => current.filter((tab) => tab.path !== targetPath));
                // 即使旧读取尚未形成 tab，也强制重读刚提交的版本；openFile 会取消旧请求。
                if (selectedExplorer) void openFile(selectedExplorer.id, targetPath, true);
              }
            } catch (error) {
              if (controller.signal.aborted) throw error;
              if (isFatalUploadTransportError(error)) {
                fatalError ??= error;
                session.close(error);
                throw error;
              }
              failures.push({
                relativePath: item.relativePath,
                message: userErrorMessage(error, "上传失败"),
              });
            } finally {
              uploadingPathsRef.current.delete(targetPath);
              activeRelativePaths.delete(targetPath);
              processedFiles++;
              progress.update(transferredBytes.value, totalBytes);
            }
          }
        };
        try {
          await Promise.allSettled(
            Array.from(
              { length: Math.min(FS_UPLOAD_CLIENT_MAX_CONCURRENT, pendingFiles.length) },
              () => worker(),
            ),
          );
          controller.signal.throwIfAborted();
          if (fatalError !== null) throw fatalError;
        } finally {
          progress.cancel();
          session.close();
        }
      }
      controller.signal.throwIfAborted();

      if (failures.length > 0) {
        const first = failures[0]!;
        setActionError(
          `上传完成：成功 ${succeededFiles}/${totalFiles} 个文件，失败 ${failures.length} 项。` +
            `首个失败：${first.relativePath}：${first.message}`,
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        setActionNotice({
          message: `上传已取消：已完成 ${succeededFiles}/${totalFiles} 个文件；已完成内容和已创建目录予以保留`,
        });
      } else {
        const message = userErrorMessage(error, "上传失败");
        setActionError(
          isFatalUploadTransportError(error)
            ? `上传中断：已完成 ${succeededFiles}/${totalFiles} 个文件；${message}`
            : message,
        );
      }
    } finally {
      uploadBusyRef.current = false;
      if (uploadControllerRef.current === controller) uploadControllerRef.current = null;
      uploadingPathsRef.current.clear();
      setUpload(null);
      refreshTree();
    }
  };

  const onUploadPicked = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const selected = Array.from(files);
    void startUpload(uploadTargetRef.current, () => localFilesManifest(selected));
  };

  // ------------------------------------------------------------ 新建 / 重命名
  const submitNameDialog = async () => {
    const dialog = nameDialog;
    if (!dialog) return;
    if (uploadBusyRef.current) {
      setActionError("正在上传文件，请等待完成或取消后再修改目录");
      return;
    }
    const name = dialog.value.trim();
    if (!name || name.includes("/")) {
      setActionError("名称不能为空且不能包含 /");
      return;
    }
    if (
      dialog.mode === "rename" &&
      tabsRef.current.some(
        (tab) =>
          tab.kind === "ready" && tab.saving && pathMatches(tab.path, dialog.target, dialog.isDir),
      )
    ) {
      setActionError("文件仍在保存中，请等待保存完成后再重命名");
      return;
    }
    if (pathMutationBusyRef.current) {
      setActionError("另一个文件路径操作仍在进行，请稍后重试");
      return;
    }
    pathMutationBusyRef.current = true;
    setPathMutationBusy(true);
    if (dialog.mode === "rename") fileReadRef.current?.controller.abort();
    setActionError(null);
    try {
      if (dialog.mode === "newFolder") {
        await mkdirRpc(rpc, joinPath(dialog.target, name));
      } else if (dialog.mode === "newFile") {
        const path = joinPath(dialog.target, name);
        await writeFileAll(rpc, path, new Uint8Array(0));
        setNameDialog(null);
        refreshTree();
        selectFile(dialog.explorerId, path);
        return;
      } else {
        const to = joinPath(parentPath(dialog.target), name);
        await renameRpc(rpc, dialog.target, to, false);
        updateTabs((items) =>
          items.map((tab) => ({
            ...tab,
            path: remapMovedPath(tab.path, dialog.target, to, dialog.isDir),
          })),
        );
        remapExplorerPaths(dialog.target, to, dialog.isDir);
        onPathMoved(dialog.target, to, dialog.isDir, false);
      }
      setNameDialog(null);
      refreshTree();
    } catch (err) {
      showError(err, "操作失败");
    } finally {
      pathMutationBusyRef.current = false;
      setPathMutationBusy(false);
    }
  };

  // ---------------------------------------------------------------- 删除
  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target) return;
    if (uploadBusyRef.current) {
      setActionError("正在上传文件，请等待完成或取消后再删除");
      return;
    }
    if (
      tabsRef.current.some(
        (tab) =>
          tab.kind === "ready" && tab.saving && pathMatches(tab.path, target.path, target.isDir),
      )
    ) {
      setDeleteTarget(null);
      setActionError("文件仍在保存中，请等待保存完成后再删除");
      return;
    }
    if (pathMutationBusyRef.current) {
      setActionError("另一个文件路径操作仍在进行，请稍后重试");
      return;
    }
    pathMutationBusyRef.current = true;
    setPathMutationBusy(true);
    fileReadRef.current?.controller.abort();
    setDeleteBusy(true);
    setActionError(null);
    try {
      await removeRpc(rpc, target.path, target.isDir);
      setDeleteTarget(null);
      const isRemoved = (path: string) =>
        path === target.path || (target.isDir && path.startsWith(`${target.path}/`));
      const retainedSelection =
        activeExplorerId &&
        activePath &&
        isRemoved(activePath) &&
        tabsRef.current.some((tab) => tab.path === activePath)
          ? { explorerId: activeExplorerId, path: activePath }
          : undefined;
      const nextTabs = tabsRef.current.flatMap((tab) => {
        if (!isRemoved(tab.path)) return [tab];
        return retainedSelection?.path === tab.path
          ? [{ ...tab, externalState: "deleted" as const }]
          : [];
      });
      updateTabs(() => nextTabs);
      removeExplorerPaths(target.path, target.isDir);
      onPathRemoved(target.path, target.isDir, retainedSelection);
      refreshTree();
    } catch (err) {
      showError(err, "删除失败");
    } finally {
      pathMutationBusyRef.current = false;
      setPathMutationBusy(false);
      setDeleteBusy(false);
    }
  };

  const discardFile = useCallback(
    (path: string) => {
      updateTabs((items) =>
        items.map((tab) =>
          tab.path === path && tab.kind === "ready"
            ? { ...tab, value: tab.savedContent, editRevision: tab.editRevision + 1, saving: false }
            : tab,
        ),
      );
      setActionError(null);
    },
    [updateTabs],
  );

  useEffect(() => {
    const element = panelElementRef.current;
    if (!element) return;
    const sync = () => {
      if (!activeRef.current) return;
      const narrow = explorerUsesDrawer(element.getBoundingClientRect().width);
      setIsNarrow(narrow);
      if (!narrow) setMobileTreeOpen(false);
    };
    sync();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", sync);
      return () => window.removeEventListener("resize", sync);
    }
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!active || !isNarrow) return;
    // 窄屏只是临时把桌面目录树让出，不写回用户保存的收起状态。
    desktopTreePanelRef.current?.collapse();
  }, [isNarrow, active]);

  useEffect(() => {
    if (
      !active ||
      isNarrow ||
      activeExplorerTreeSize === undefined ||
      activeExplorerTreeCollapsed === undefined
    )
      return;
    const element = desktopGroupElementRef.current;
    if (!element) return;
    const targetLayout = explorerPanelLayout(activeExplorerTreeSize, activeExplorerTreeCollapsed);
    return scheduleExplorerPanelLayoutRestore(
      element,
      () => desktopGroupRef.current,
      targetLayout,
      {
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (frame) => window.cancelAnimationFrame(frame),
        observe: (target, callback) => {
          const observer = new ResizeObserver(callback);
          observer.observe(target);
          return () => observer.disconnect();
        },
      },
      () => desktopTreePanelRef.current,
    );
  }, [active, activeExplorerId, activeExplorerTreeCollapsed, activeExplorerTreeSize, isNarrow]);

  // ---------------------------------------------------------------- 渲染
  const connectionActionMessage =
    connState === "connecting"
      ? "电脑通道正在连接，请稍候"
      : connState === "error"
        ? (notice ?? "电脑通道连接失败，请点击“重新连接”后重试")
        : "电脑通道尚未连接，请点击“重新连接”后重试";
  const fileStatusMap = Object.fromEntries(
    tabs.map((tab) => [
      tab.path,
      {
        dirty: tab.kind === "ready" && tab.value !== tab.savedContent,
        saving: tab.kind === "ready" && tab.saving,
      },
    ]),
  );
  const revealTree = () => {
    if (!activeExplorer) return;
    if (isNarrow) {
      setMobileTreeOpen(true);
      return;
    }
    desktopTreePanelRef.current?.resize(`${activeExplorer.treeSize}%`);
    onTreeLayoutChange(activeExplorer.id, activeExplorer.treeSize, false);
  };
  const openBreadcrumbDirectory = (path: string) => {
    if (!activeExplorerId || !connected || activeExplorerNavigating) return;
    revealTree();
    void navigateDirectory(activeExplorerId, path);
  };
  const renderEditor = () => (
    <EditorArea
      previewScopeKey={JSON.stringify([machineId, statusKey, activeExplorerId])}
      rootPath="/"
      readResource={readResource}
      onOpenPreviewFile={(path) => {
        if (activeExplorerId) selectFile(activeExplorerId, path);
      }}
      onReload={reloadFile}
      onToggleSource={(path) =>
        updateTabs((items) =>
          items.map((item) =>
            item.path === path && item.kind === "ready"
              ? { ...item, sourceView: !item.sourceView }
              : item,
          ),
        )
      }
      active={active}
      ownerId={statusKey}
      machineId={machineId}
      searchReveal={searchReveal?.explorerId === activeExplorerId ? searchReveal : null}
      onSearchRevealHandled={() => {
        searchRevealRef.current = null;
        setSearchReveal(null);
      }}
      onSearchRevealFailure={() =>
        setActionNotice({ message: "搜索结果与当前文件内容不一致，已保留当前内容，请重新搜索" })
      }
      openFiles={tabs
        .filter((tab): tab is Extract<EditorTab, { kind: "ready" }> => tab.kind === "ready")
        .map((tab) => ({
          path: tab.path,
          value: tab.value,
          language: languageForPath(tab.path),
        }))}
      tab={activeTab}
      retainedTab={retainedEditorTab}
      selectedPath={activePath}
      pendingPath={openingPath === activePath ? openingPath : null}
      treeHidden={isNarrow || Boolean(activeExplorer?.treeCollapsed)}
      mobile={isPhone}
      responsiveResolved={responsiveResolved}
      onRevealTree={revealTree}
      onOpenDirectory={activeExplorerId ? openBreadcrumbDirectory : undefined}
      directoryNavigationDisabled={!connected || activeExplorerNavigating}
      writeLocked={Boolean(
        retainedEditorTab &&
        upload?.phase === "uploading" &&
        upload.activePaths.some(
          (relativePath) => retainedEditorTab.path === joinPath(upload.targetDir, relativePath),
        ),
      )}
      onChange={(value) => {
        const editorPath = retainedEditorTab?.path;
        if (!editorPath) return;
        updateTabs((items) =>
          items.map((tab) =>
            tab.path === editorPath &&
            tab.kind === "ready" &&
            tab.externalState !== "deleted" &&
            tab.value !== value
              ? { ...tab, value, editRevision: tab.editRevision + 1 }
              : tab,
          ),
        );
      }}
      onSave={() => void saveFile(retainedEditorTab?.path)}
      onDiscard={(path) => setDiscardPath(path)}
      onDownload={(path) => void downloadFile(path, "file")}
    />
  );
  const renderTree = (explorer: ExplorerWorkbenchTab, closeMobile = false) => {
    const searchState = search.state(explorer.id);
    const explorerState = explorerStates[explorer.id] ?? createExplorerViewState(rootPath);
    const explorerDir = explorerState.currentDir;
    const directoryUnavailable = !connected || explorerState.navigating;
    const directoryDisabledReason = !connected ? connectionActionMessage : "正在切换目录";
    const uploadUnavailable =
      directoryUnavailable || pathMutationBusy || upload !== null || download !== null;
    const uploadDisabledReason = directoryUnavailable
      ? directoryDisabledReason
      : pathMutationBusy
        ? "文件路径正在变更，请等待操作完成"
        : download
          ? "已有下载任务正在进行"
          : "已有上传任务正在进行";
    return (
      <div
        data-directory-navigation={explorer.id}
        className={`${closeMobile ? "cm-sidebar-surface" : "cm-workspace-surface"} flex h-full min-h-0 flex-col`}
      >
        <div
          role="toolbar"
          aria-label="文件目录操作"
          className="cm-file-tree-toolbar cm-toolbar h-auto shrink-0 flex-col items-stretch gap-1 px-2 py-1 text-xs"
        >
          <div
            data-file-tree-toolbar-row="navigation"
            className="flex w-full min-w-0 items-center gap-1"
          >
            <ToolButton
              title="后退（Alt+←）"
              disabled={directoryUnavailable || explorerState.backStack.length === 0}
              disabledReason={directoryUnavailable ? directoryDisabledReason : "没有可返回的目录"}
              onDisabledClick={
                directoryUnavailable ? () => setActionError(directoryDisabledReason) : undefined
              }
              onClick={() => navigateBack(explorer.id)}
            >
              <ArrowLeft size={13} />
            </ToolButton>
            <ToolButton
              title="向上（Alt+↑）"
              disabled={directoryUnavailable || explorerDir === "/"}
              disabledReason={directoryUnavailable ? directoryDisabledReason : "已经位于根目录"}
              onDisabledClick={
                directoryUnavailable ? () => setActionError(directoryDisabledReason) : undefined
              }
              onClick={() => navigateUp(explorer.id)}
            >
              <ArrowUp size={13} />
            </ToolButton>
            <input
              aria-label="当前目录路径"
              title={explorerDir}
              value={explorerState.pathDraft}
              disabled={directoryUnavailable}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              onChange={(event) =>
                updateExplorerState(explorer.id, (state) => ({
                  ...state,
                  pathDraft: event.target.value,
                }))
              }
              onBlur={() =>
                updateExplorerState(explorer.id, (state) => ({
                  ...state,
                  pathDraft: state.currentDir,
                }))
              }
              onDoubleClick={(event) => {
                const target = directoryPathAtSelection(
                  event.currentTarget.value,
                  event.currentTarget.selectionStart,
                );
                if (target && target !== explorerDir) void navigateDirectory(explorer.id, target);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void navigateDirectory(explorer.id, event.currentTarget.value);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  updateExplorerState(explorer.id, (state) => ({
                    ...state,
                    pathDraft: state.currentDir,
                  }));
                  event.currentTarget.blur();
                }
              }}
              className="cm-file-tree-path-input min-w-0 flex-1"
            />
            <ToolButton
              title={closeMobile ? "关闭目录树" : "收起目录树"}
              onClick={() => {
                if (closeMobile) setMobileTreeOpen(false);
                else {
                  desktopTreePanelRef.current?.collapse();
                  onTreeLayoutChange(explorer.id, explorer.treeSize, true);
                }
              }}
            >
              <PanelRightClose size={13} />
            </ToolButton>
          </div>
          <div
            data-file-tree-toolbar-row="actions"
            className="flex w-full shrink-0 items-center justify-start gap-1"
          >
            <ToolButton
              title="新建文件"
              disabled={directoryUnavailable}
              disabledReason={directoryDisabledReason}
              onDisabledClick={() => setActionError(directoryDisabledReason)}
              onClick={() =>
                setNameDialog({
                  mode: "newFile",
                  target: explorerDir,
                  isDir: false,
                  value: "",
                  explorerId: explorer.id,
                })
              }
            >
              <FilePlus2 size={13} />
            </ToolButton>
            <ToolButton
              title="新建文件夹"
              disabled={directoryUnavailable}
              disabledReason={directoryDisabledReason}
              onDisabledClick={() => setActionError(directoryDisabledReason)}
              onClick={() =>
                setNameDialog({
                  mode: "newFolder",
                  target: explorerDir,
                  isDir: true,
                  value: "",
                  explorerId: explorer.id,
                })
              }
            >
              <FolderPlus size={13} />
            </ToolButton>
            <ToolButton
              title="上传"
              disabled={uploadUnavailable}
              disabledReason={uploadDisabledReason}
              onDisabledClick={() => setActionError(uploadDisabledReason)}
              onClick={() => {
                uploadTargetRef.current = explorerDir;
                uploadInputRef.current?.click();
              }}
            >
              <UploadIcon size={13} />
            </ToolButton>
            <ToolButton
              title="刷新"
              disabled={directoryUnavailable}
              disabledReason={directoryDisabledReason}
              onDisabledClick={() => setActionError(directoryDisabledReason)}
              onClick={refreshTree}
            >
              <RefreshCw size={13} />
            </ToolButton>
            <ToolButton
              title={
                searchState.view === "search" ? "返回目录树" : "搜索工作区（Ctrl/Cmd+Shift+F）"
              }
              disabled={!workspaceId}
              onClick={() =>
                search.setView(explorer.id, searchState.view === "search" ? "tree" : "search")
              }
            >
              {searchState.view === "search" ? <ArrowLeft size={13} /> : <Search size={13} />}
            </ToolButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {searchState.view === "search" ? (
            <FileSearchPanel
              state={searchState}
              disabled={!connected || !available}
              visible={
                active &&
                activeExplorerId === explorer.id &&
                (closeMobile ? mobileTreeOpen : !explorer.treeCollapsed)
              }
              onDraft={(patch) => search.patchDraft(explorer.id, patch)}
              onSubmit={() => search.submit(explorer.id)}
              onCancel={search.cancel}
              onBack={() => search.setView(explorer.id, "tree")}
              onOpen={(searchRoot, match) => openSearchResult(explorer.id, searchRoot, match)}
              onReveal={(searchRoot, match) =>
                void revealSearchResult(explorer.id, searchRoot, match)
              }
            />
          ) : connected && explorerTreeRoot !== null ? (
            <FileTree
              rpc={rpc}
              active={
                active &&
                activeExplorerId === explorer.id &&
                (closeMobile ? mobileTreeOpen : !explorer.treeCollapsed)
              }
              rootPaths={[explorerTreeRoot]}
              refreshSignal={refreshSignal}
              currentDirectoryPath={explorerDir}
              selectedPath={
                treeReveal?.explorerId === explorer.id ? treeReveal.path : explorer.activeFilePath
              }
              revealRequest={
                treeReveal?.explorerId === explorer.id && !treeReveal.done ? treeReveal : null
              }
              onRevealed={() =>
                setTreeReveal((current) => (current ? { ...current, done: true } : null))
              }
              fileStatuses={fileStatusMap}
              gitDecorations={gitDecorations}
              localDropDisabled={uploadUnavailable}
              onLocalDrop={(targetDir, items) =>
                void startUpload(targetDir, (signal) => collectLocalDropManifest(items, signal))
              }
              onOpenFile={(path) => {
                setTreeReveal(null);
                searchRevealRef.current = null;
                setSearchReveal(null);
                selectFile(explorer.id, path);
                if (explorer.activeFilePath === path) void openFile(explorer.id, path);
                if (closeMobile) setMobileTreeOpen(false);
              }}
              onEnterDir={(dir) => void navigateDirectory(explorer.id, dir)}
              onNewFile={(dir) =>
                setNameDialog({
                  mode: "newFile",
                  target: dir,
                  isDir: false,
                  value: "",
                  explorerId: explorer.id,
                })
              }
              onNewFolder={(dir) =>
                setNameDialog({
                  mode: "newFolder",
                  target: dir,
                  isDir: true,
                  value: "",
                  explorerId: explorer.id,
                })
              }
              onRename={(path, isDir) =>
                setNameDialog({
                  mode: "rename",
                  target: path,
                  isDir,
                  value: baseName(path),
                  explorerId: explorer.id,
                })
              }
              onDelete={(path, name, isDir) => setDeleteTarget({ path, name, isDir })}
              onDownload={(path, kind) => void downloadFile(path, kind)}
              onMove={(path, targetDir, isDir) => void moveEntry(path, targetDir, isDir)}
              onMoveRequest={(path, isDir) =>
                setMoveDialog({ path, isDir, targetDir: parentPath(path) })
              }
            />
          ) : (
            <div className="space-y-1 p-2" aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="h-6 animate-pulse rounded bg-zinc-800/50"
                  style={{ width: `${72 - index * 16}%` }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };
  const uploadPercent = upload?.phase === "uploading" ? uploadProgressPercent(upload) : null;
  return (
    <div
      ref={panelElementRef}
      className="flex h-full flex-col"
      onKeyDownCapture={(event) => {
        if (
          active &&
          workspaceId &&
          activeExplorerId &&
          (event.ctrlKey || event.metaKey) &&
          event.shiftKey &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          event.stopPropagation();
          search.setView(activeExplorerId, "search");
          revealTree();
        }
      }}
    >
      {(connState === "error" || connState === "disconnected" || upload || download) && (
        <div
          className="flex min-h-8 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1 text-[11px] text-zinc-400"
          aria-live="polite"
        >
          {(connState === "error" || connState === "disconnected") && (
            <>
              <span className={connState === "error" ? "text-red-400" : undefined}>
                {notice ?? (connState === "error" ? "连接错误" : "已断开")}
              </span>
              <button type="button" onClick={() => void connect()} className="cm-button">
                重新连接
              </button>
            </>
          )}
          {upload && (
            <>
              <div className="ml-auto min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" title={upload.targetDir}>
                    {upload.phase === "scanning"
                      ? `正在读取拖入内容 · ${upload.targetDir}`
                      : `上传 ${upload.processedFiles}/${upload.totalFiles} · ${upload.activePaths.length > 0 ? `正在传输 ${upload.activePaths.length} 个：${upload.activePaths.join("、")}` : "正在准备"} · 已传输 ${formatBytes(upload.transferredBytes)}/${formatBytes(upload.totalBytes)}${upload.failureCount > 0 ? ` · 失败 ${upload.failureCount}` : ""}`}
                  </span>
                  {uploadPercent !== null && (
                    <span className="shrink-0 tabular-nums text-zinc-300">{uploadPercent}%</span>
                  )}
                </div>
                <div
                  role="progressbar"
                  aria-label={upload.phase === "scanning" ? "正在读取待上传内容" : "文件上传进度"}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={uploadPercent ?? undefined}
                  aria-valuetext={
                    upload.phase === "scanning"
                      ? "正在读取待上传内容"
                      : `${uploadPercent}%（${formatBytes(upload.transferredBytes)}/${formatBytes(upload.totalBytes)}）`
                  }
                  className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800"
                >
                  <span
                    key={upload.phase}
                    className={`block h-full rounded-full bg-[var(--cm-accent)] ${upload.phase === "scanning" ? "cm-progress-indeterminate" : "motion-safe:transition-[width] motion-safe:duration-150"}`}
                    style={uploadPercent === null ? undefined : { width: `${uploadPercent}%` }}
                  />
                </div>
              </div>
              <button
                type="button"
                className="cm-button shrink-0"
                onClick={() => uploadControllerRef.current?.abort()}
              >
                取消
              </button>
            </>
          )}
          {download && (
            <>
              <div className="ml-auto min-w-0 flex-1" title={download.path}>
                <span className="block truncate">
                  {download.kind === "directory"
                    ? `打包并下载 ${baseName(download.path) || "root"} · 已处理 ${download.processedEntries} 项 · 源文件 ${formatBytes(download.sourceBytes)} · 已接收 ${formatBytes(download.receivedBytes)}${download.skippedEntries > 0 ? ` · 跳过 ${download.skippedEntries} 项` : ""}`
                    : `下载 ${baseName(download.path)} · ${formatBytes(download.receivedBytes)}/${formatBytes(download.totalBytes ?? 0)} · ${download.totalBytes && download.totalBytes > 0 ? `${Math.min(100, Math.floor((download.receivedBytes / download.totalBytes) * 100))}%` : "0%"}`}
                  {download.retryAttempt > 0
                    ? ` · 正在重试 ${download.retryAttempt}/${download.retryLimit}`
                    : ""}
                </span>
                {download.kind === "directory" && (
                  <div
                    role="progressbar"
                    aria-label="目录打包下载进度"
                    aria-valuetext={`已处理 ${download.processedEntries} 项，已接收 ${formatBytes(download.receivedBytes)}`}
                    className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800"
                  >
                    <span className="cm-progress-indeterminate block h-full rounded-full bg-[var(--cm-accent)]" />
                  </div>
                )}
              </div>
              <button
                type="button"
                className="cm-button shrink-0"
                onClick={() => downloadControllerRef.current?.abort()}
              >
                取消
              </button>
            </>
          )}
        </div>
      )}

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          onUploadPicked(event.target.files);
          event.target.value = "";
        }}
      />

      {actionError && (
        <div className="border-b px-3 py-1.5 text-xs cm-banner-danger">{actionError}</div>
      )}
      {connected && rootFallbackNotice && (
        <div
          role="status"
          className="flex min-w-0 items-center gap-2 border-b px-3 py-1.5 text-xs cm-banner-warning"
        >
          <span className="min-w-0 flex-1 truncate">
            当前电脑暂不支持访问系统根目录，已回退到项目目录；升级 machine-agentd
            后可访问完整文件系统。
          </span>
          <button
            type="button"
            aria-label="关闭根目录兼容提示"
            className="cm-icon-button shrink-0"
            onClick={() => setRootFallbackNotice(false)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
      {actionNotice && (
        <ActionNoticeBanner
          notice={actionNotice}
          onDismiss={() => setActionNotice(null)}
          onOpenError={(error) => showError(error, "无法打开下载目录")}
        />
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup
          id={`workspace-files-${statusKey}-${filesPanelGroupId}`}
          groupRef={desktopGroupRef}
          elementRef={desktopGroupElementRef}
          orientation="horizontal"
          defaultLayout={initialDesktopLayout}
          onLayoutChanged={(layout, meta) => {
            if (isNarrow || !meta.isUserInteraction || !activeExplorer) return;
            const nextSize = layout.tree ?? activeExplorer.treeSize;
            onTreeLayoutChange(
              activeExplorer.id,
              nextSize < 1 ? activeExplorer.treeSize : nextSize,
              nextSize < 1,
            );
          }}
        >
          <ResizablePanel id="editor" minSize="0px">
            {renderEditor()}
          </ResizablePanel>
          <ResizableHandle
            axis="vertical"
            className={
              isNarrow || activeExplorer?.treeCollapsed
                ? "pointer-events-none opacity-0"
                : undefined
            }
          />
          <ResizablePanel
            id="tree"
            panelRef={desktopTreePanelRef}
            collapsible
            collapsedSize="0px"
            minSize="220px"
            maxSize="45%"
          >
            {!isNarrow &&
              explorers.map((explorer) => (
                <div
                  key={explorer.id}
                  className={`h-full ${activeExplorerId === explorer.id ? "block" : "hidden"}`}
                >
                  {renderTree(explorer)}
                </div>
              ))}
          </ResizablePanel>
        </ResizablePanelGroup>

        {isNarrow && (
          <button
            type="button"
            aria-label="关闭目录树"
            inert={!mobileTreeOpen}
            aria-hidden={!mobileTreeOpen}
            tabIndex={mobileTreeOpen ? 0 : -1}
            className={`absolute inset-0 z-10 bg-[var(--cm-overlay)] transition-opacity duration-150 motion-reduce:transition-none ${
              mobileTreeOpen ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
            onClick={() => setMobileTreeOpen(false)}
          />
        )}
        {isNarrow && (
          <aside
            aria-label="文件目录树"
            aria-hidden={!mobileTreeOpen}
            inert={!mobileTreeOpen}
            className={`cm-sidebar-surface absolute inset-y-0 right-0 z-20 border-l border-zinc-800 transition-transform duration-150 motion-reduce:transition-none ${
              isPhone ? "w-2/3" : "w-[min(85vw,320px)]"
            } ${mobileTreeOpen ? "translate-x-0" : "translate-x-full"}`}
          >
            {explorers.map((explorer) => (
              <div
                key={explorer.id}
                className={`h-full ${activeExplorerId === explorer.id ? "block" : "hidden"}`}
              >
                {renderTree(explorer, true)}
              </div>
            ))}
          </aside>
        )}
      </div>

      <Dialog
        open={nameDialog !== null}
        onOpenChange={(open) => {
          if (!open) setNameDialog(null);
        }}
      >
        {nameDialog && (
          <DialogContent className="max-w-sm border-zinc-800 bg-zinc-900 text-xs text-zinc-100">
            <DialogHeader>
              <DialogTitle className="text-xs">
                {nameDialog.mode === "rename"
                  ? `重命名 ${nameDialog.isDir ? "文件夹" : "文件"}`
                  : nameDialog.mode === "newFolder"
                    ? "新建文件夹"
                    : "新建文件"}
              </DialogTitle>
              <DialogDescription className="break-all text-xs text-zinc-500">
                {nameDialog.mode === "rename" ? nameDialog.target : `位置：${nameDialog.target}`}
              </DialogDescription>
            </DialogHeader>
            <input
              autoFocus
              value={nameDialog.value}
              onChange={(e) => setNameDialog({ ...nameDialog, value: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && void submitNameDialog()}
              placeholder="名称"
              className="cm-input"
            />
            <DialogFooter className="border-zinc-800 bg-zinc-950/40">
              <button type="button" onClick={() => setNameDialog(null)} className="cm-button">
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitNameDialog()}
                className="cm-button-primary"
              >
                确定
              </button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={moveDialog !== null}
        onOpenChange={(open) => {
          if (!open && !moveBusy) setMoveDialog(null);
        }}
      >
        {moveDialog && (
          <DialogContent
            className="max-w-md border-zinc-800 bg-zinc-900 text-xs text-zinc-100"
            showCloseButton={!moveBusy}
          >
            <DialogHeader>
              <DialogTitle className="text-xs">移动到目录</DialogTitle>
              <DialogDescription className="break-all text-xs text-zinc-500">
                {moveDialog.path}
              </DialogDescription>
            </DialogHeader>
            <input
              autoFocus
              value={moveDialog.targetDir}
              onChange={(event) => setMoveDialog({ ...moveDialog, targetDir: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && moveDialog.targetDir.trim() && !moveBusy) {
                  void moveEntry(moveDialog.path, moveDialog.targetDir.trim(), moveDialog.isDir);
                }
              }}
              placeholder="例如 /workspace/src"
              className="cm-input"
            />
            <DialogFooter className="border-zinc-800 bg-zinc-950/40">
              <button
                type="button"
                onClick={() => setMoveDialog(null)}
                disabled={moveBusy}
                className="cm-button"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!moveDialog.targetDir.trim() || moveBusy}
                onClick={() =>
                  void moveEntry(moveDialog.path, moveDialog.targetDir.trim(), moveDialog.isDir)
                }
                className="cm-button-primary"
              >
                {moveBusy ? "移动中…" : "移动"}
              </button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`删除${deleteTarget?.isDir ? "文件夹" : "文件"}`}
        body={
          <>
            确定删除 <span className="font-medium text-zinc-200">{deleteTarget?.name}</span> 吗？
            {deleteTarget?.isDir && " 该文件夹及其全部内容将被递归删除，"}
            <span className="text-red-400">不可恢复</span>
          </>
        }
        confirmLabel="确认删除"
        busy={deleteBusy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
      <ConfirmDialog
        open={reloadPath !== null}
        title="重新加载文件"
        body="重新加载会丢弃此文件的未保存修改，是否继续？"
        confirmLabel="放弃修改并重新加载"
        onCancel={() => setReloadPath(null)}
        onConfirm={() => {
          const path = reloadPath;
          setReloadPath(null);
          if (path && activeExplorerId) void openFile(activeExplorerId, path, true);
        }}
      />
      <ConfirmDialog
        open={discardPath !== null}
        title="放弃未保存修改"
        body={discardPath ? `确定放弃 ${baseName(discardPath)} 的全部未保存修改吗？` : ""}
        confirmLabel="放弃修改"
        busy={false}
        onCancel={() => setDiscardPath(null)}
        onConfirm={() => {
          const path = discardPath;
          setDiscardPath(null);
          if (path) discardFile(path);
        }}
      />
      <ConfirmDialog
        open={moveConflict !== null}
        title="目标已存在"
        body={
          <>
            目标 <span className="font-medium text-zinc-200">{moveConflict?.to}</span> 已存在。
            继续会覆盖目标内容，且无法恢复
          </>
        }
        confirmLabel="覆盖并移动"
        busy={moveBusy}
        onCancel={() => setMoveConflict(null)}
        onConfirm={() => {
          if (moveConflict) {
            void moveEntry(moveConflict.path, moveConflict.targetDir, moveConflict.isDir, true);
          }
        }}
      />
    </div>
  );
}

function EditorArea(props: {
  searchReveal: FileSearchReveal | null;
  onSearchRevealFailure: () => void;
  onSearchRevealHandled: () => void;
  previewScopeKey: string;
  rootPath: string;
  readResource: (path: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;
  onOpenPreviewFile: (path: string) => void;
  onReload: (path: string) => void;
  onToggleSource: (path: string) => void;
  active: boolean;
  ownerId: string;
  machineId: string;
  openFiles: ReadonlyArray<{ path: string; value: string; language: string }>;
  tab: EditorTab | null;
  retainedTab: Extract<EditorTab, { kind: "ready" }> | null;
  selectedPath: string | null;
  pendingPath: string | null;
  treeHidden: boolean;
  mobile: boolean;
  responsiveResolved: boolean;
  onRevealTree: () => void;
  onOpenDirectory?: (path: string) => void;
  directoryNavigationDisabled: boolean;
  writeLocked: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onDiscard: (path: string) => void;
  onDownload: (path: string) => void;
}) {
  const { tab } = props;
  const [desktopEditorLoaded, setDesktopEditorLoaded] = useState(false);
  const [mobileEditorLoaded, setMobileEditorLoaded] = useState(false);
  const editorBackground = getThemeDefinition(useThemeStore((s) => s.themeId)).editor.background;
  if (props.responsiveResolved && props.mobile && !mobileEditorLoaded) {
    setMobileEditorLoaded(true);
  }
  if (props.responsiveResolved && !props.mobile && !desktopEditorLoaded) {
    setDesktopEditorLoaded(true);
  }
  const selectedPath = props.selectedPath;
  const { displayedTab, textFormat, previewTooLarge } = useMemo(() => {
    const readyTab = tab?.kind === "ready" ? tab : null;
    const displayedTab = selectVisibleEditorItem(readyTab, selectedPath);
    const textFormat = displayedTab ? previewFormat(displayedTab.path) : null;
    return {
      displayedTab,
      textFormat,
      previewTooLarge: Boolean(
        displayedTab &&
        textFormat &&
        isTextPreview(textFormat.kind) &&
        new TextEncoder().encode(displayedTab.value).length > MAX_TEXT_PREVIEW_BYTES,
      ),
    };
  }, [tab, selectedPath]);
  const preview =
    tab?.kind === "preview" ||
    Boolean(
      displayedTab &&
      textFormat &&
      isTextPreview(textFormat.kind) &&
      !previewTooLarge &&
      !displayedTab.sourceView,
    );
  const dirty = displayedTab ? displayedTab.value !== displayedTab.savedContent : false;
  const externalState = tab?.path === selectedPath ? tab.externalState : undefined;
  const deleted = externalState === "deleted";
  const editorReadOnly = props.writeLocked || deleted;
  const toolbarPath = props.selectedPath ?? props.pendingPath;
  const showToolbar = Boolean(toolbarPath) && tab?.kind !== "readonly";
  return (
    <div className="relative flex h-full min-h-0 flex-col" aria-busy={props.pendingPath !== null}>
      {showToolbar && toolbarPath && (
        <div
          role="toolbar"
          aria-label="文件操作"
          className="cm-file-editor-toolbar flex min-h-8 shrink-0 items-center gap-2 border-b border-zinc-800 px-2 py-1 text-xs sm:px-3"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <PathCrumbs
              path={toolbarPath}
              className="min-w-0 flex-1"
              onOpenDirectory={props.onOpenDirectory}
              disabled={props.directoryNavigationDisabled}
            />
            {dirty && <span className="shrink-0 text-amber-400">● 未保存</span>}
            {externalState && (
              <span className="shrink-0 text-red-400">
                ● {deleted ? "文件已删除" : "外部已修改"}
              </span>
            )}
            {props.writeLocked && <span className="shrink-0 text-sky-400">上传中，只读</span>}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {displayedTab && textFormat && isTextPreview(textFormat.kind) && (
              <ToolButton
                disabled={previewTooLarge}
                title={previewTooLarge ? "超过 2 MiB，仅支持源码编辑（编辑上限 5 MiB）" : undefined}
                onClick={() => props.onToggleSource(displayedTab.path)}
              >
                {preview ? "源码" : "预览"}
              </ToolButton>
            )}
            <ToolButton
              title="重新加载文件"
              disabled={Boolean(displayedTab?.saving) || editorReadOnly}
              disabledReason={deleted ? "文件已删除，无法重新加载" : undefined}
              onClick={() => props.onReload(toolbarPath)}
            >
              <RefreshCw size={13} />
            </ToolButton>
            <ToolButton
              title="下载文件"
              disabled={deleted}
              disabledReason="文件已删除，无法从原路径下载"
              onClick={() => props.onDownload(toolbarPath)}
            >
              <UploadIcon size={13} className="rotate-180" />
            </ToolButton>
            {tab?.kind !== "preview" && (
              <>
                <ToolButton
                  disabledReason={
                    deleted
                      ? "文件已删除，仅保留只读内容"
                      : externalState
                        ? "请重新加载并核对外部修改后再保存"
                        : undefined
                  }
                  disabled={
                    !displayedTab ||
                    displayedTab.saving ||
                    !dirty ||
                    props.writeLocked ||
                    Boolean(externalState)
                  }
                  onClick={props.onSave}
                >
                  {displayedTab?.saving ? "保存中…" : props.mobile ? "保存" : "保存（⌘/Ctrl+S）"}
                </ToolButton>
                {dirty && displayedTab && (
                  <ToolButton
                    title="放弃未保存修改"
                    disabled={editorReadOnly}
                    disabledReason={deleted ? "文件已删除，仅保留只读内容" : undefined}
                    onClick={() => props.onDiscard(displayedTab.path)}
                  >
                    <RotateCcw size={13} />
                    放弃
                  </ToolButton>
                )}
              </>
            )}
            {props.treeHidden && (
              <RevealTreeButton className="cm-icon-button shrink-0" onClick={props.onRevealTree} />
            )}
          </div>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className={displayedTab && !preview ? "h-full overflow-hidden" : "hidden"}
          aria-hidden={!displayedTab || preview}
        >
          {props.retainedTab && mobileEditorLoaded && (
            <div className={props.mobile ? "h-full" : "hidden"} aria-hidden={!props.mobile}>
              <MobileFileEditor
                searchReveal={props.active && props.mobile && !preview ? props.searchReveal : null}
                onSearchRevealFailure={props.onSearchRevealFailure}
                onSearchRevealHandled={props.onSearchRevealHandled}
                key={props.retainedTab.path}
                path={props.retainedTab.path}
                value={props.retainedTab.value}
                readOnly={editorReadOnly}
                onChange={props.onChange}
                onSave={props.onSave}
              />
            </div>
          )}
          {props.retainedTab && desktopEditorLoaded && (
            <div className={props.mobile ? "hidden" : "h-full"} aria-hidden={props.mobile}>
              <Suspense
                fallback={<div className="h-full" style={{ backgroundColor: editorBackground }} />}
              >
                <FileEditor
                  searchReveal={props.searchReveal}
                  onSearchRevealFailure={props.onSearchRevealFailure}
                  onSearchRevealHandled={props.onSearchRevealHandled}
                  active={props.active && !props.mobile && !preview}
                  ownerId={props.ownerId}
                  machineId={props.machineId}
                  path={props.retainedTab.path}
                  value={props.retainedTab.value}
                  language={languageForPath(props.retainedTab.path)}
                  openFiles={props.openFiles}
                  readOnly={editorReadOnly}
                  onChange={props.onChange}
                  onSave={props.onSave}
                />
              </Suspense>
            </div>
          )}
        </div>

        {preview && tab && tab.path === props.selectedPath && (
          <div className="absolute inset-0 cm-workspace-surface">
            <Suspense fallback={null}>
              <FilePreview
                key={tab.path}
                previewScopeKey={props.previewScopeKey}
                path={tab.path}
                rootPath={props.rootPath}
                format={tab.kind === "preview" ? tab.format : textFormat!}
                bytes={tab.kind === "preview" ? tab.bytes : undefined}
                text={tab.kind === "ready" ? tab.value : undefined}
                active={props.active}
                readResource={props.readResource}
                onOpenFile={props.onOpenPreviewFile}
              />
            </Suspense>
          </div>
        )}
        {!displayedTab && tab?.kind !== "readonly" && tab?.kind !== "preview" && (
          // 空白状态跟随工作区主题；文件打开期间与 Monaco 同色，避免加载闪屏。
          <div
            className={`absolute inset-0 ${toolbarPath ? "" : "cm-workspace-surface"}`}
            style={toolbarPath ? { backgroundColor: editorBackground } : undefined}
          >
            {props.treeHidden && !showToolbar && <RevealTreeButton onClick={props.onRevealTree} />}
          </div>
        )}
        {tab?.kind === "readonly" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-sm">
            {props.treeHidden && <RevealTreeButton onClick={props.onRevealTree} />}
            <PathCrumbs
              path={tab.path}
              onOpenDirectory={props.onOpenDirectory}
              disabled={props.directoryNavigationDisabled}
            />
            <p className="text-zinc-400">{tab.reason}</p>
            {tab.externalState && (
              <p className="text-red-400">
                {tab.externalState === "deleted" ? "文件已删除" : "文件已在外部修改"}
              </p>
            )}
            <button
              type="button"
              disabled={tab.externalState === "deleted"}
              onClick={() => props.onDownload(tab.path)}
              className="rounded border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              下载（{formatBytes(tab.size)}）
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MobileFileEditor(props: {
  searchReveal: FileSearchReveal | null;
  onSearchRevealFailure: () => void;
  onSearchRevealHandled: () => void;
  path: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollPositionRef = useRef<FileScrollPosition | null>(null);
  const renderedValueRef = useRef(props.value);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (renderedValueRef.current !== props.value && element && scrollPositionRef.current) {
      const restored = resolveFileScrollPosition(scrollPositionRef.current, element);
      element.scrollTop = restored.top;
      element.scrollLeft = restored.left;
      scrollPositionRef.current = captureFileScrollPosition(element);
    }
    renderedValueRef.current = props.value;
  }, [props.value]);
  const handledReveal = useRef<number | null>(null);
  useEffect(() => {
    const request = props.searchReveal;
    const element = textRef.current;
    if (!request || request.path !== props.path || request.id === handledReveal.current || !element)
      return;
    handledReveal.current = request.id;
    props.onSearchRevealHandled();
    // Textareas normalize CRLF/CR to LF. Selection offsets must use the actual DOM value.
    const range = searchMatchOffsets(element.value, request.match);
    if (!range) {
      props.onSearchRevealFailure();
      return;
    }
    element.focus();
    element.setSelectionRange(range.start, range.end);
    element.scrollTop = Math.max(
      0,
      (request.match.line - 3) * (parseFloat(getComputedStyle(element).lineHeight) || 20),
    );
    scrollPositionRef.current = captureFileScrollPosition(element);
  }, [props]);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(false);
  const normalizedQuery = query.toLocaleLowerCase();
  const matchCount = normalizedQuery
    ? props.value.toLocaleLowerCase().split(normalizedQuery).length - 1
    : 0;

  const findNext = () => {
    const element = textRef.current;
    if (!element || !normalizedQuery) return;
    const value = element.value.toLocaleLowerCase();
    const start = element.selectionEnd;
    const index = value.indexOf(normalizedQuery, start);
    const next = index >= 0 ? index : value.indexOf(normalizedQuery);
    if (next < 0) return;
    element.focus();
    element.setSelectionRange(next, next + query.length);
  };

  const copySelection = async () => {
    const element = textRef.current;
    if (!element) return;
    const selected = element.value.slice(element.selectionStart, element.selectionEnd);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(selected || element.value);
      } else {
        element.focus();
        if (!selected) element.select();
        document.execCommand("copy");
      }
    } catch {
      // Keep the current selection so the user can use the system copy action.
      element.focus();
    }
  };

  return (
    <div className="cm-mobile-code-editor flex h-full min-h-0 flex-col bg-[var(--cm-surface-panel)]">
      <div className="cm-mobile-code-editor-toolbar flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 p-1.5">
        <label className="cm-mobile-code-editor-search flex min-w-36 flex-1 items-center gap-1 rounded-[8px] border border-zinc-700 bg-zinc-950 px-2">
          <Search size={12} className="shrink-0 text-zinc-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && findNext()}
            className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none"
            aria-label="在文件中查找"
            placeholder="在文件中查找"
          />
          {query && <span className="text-[10px] text-zinc-600">{matchCount}</span>}
        </label>
        <button type="button" className="cm-icon-button" onClick={findNext} aria-label="查找下一个">
          <Search size={13} />
        </button>
        <button
          type="button"
          className="cm-icon-button"
          onClick={() => void copySelection()}
          aria-label="复制选中内容或整个文件"
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          className={`cm-icon-button ${wrap ? "text-[var(--cm-accent)]" : ""}`}
          onClick={() => setWrap((value) => !value)}
          aria-label={wrap ? "关闭自动换行" : "开启自动换行"}
        >
          <WrapText size={13} />
        </button>
        <button
          type="button"
          className={`cm-button shrink-0 ${editing ? "text-[var(--cm-accent)]" : ""}`}
          disabled={props.readOnly}
          onClick={() => setEditing((value) => !value)}
        >
          {editing ? <Eye size={13} /> : <Pencil size={13} />}
          {editing ? "查看" : "编辑"}
        </button>
      </div>
      <textarea
        ref={textRef}
        aria-label={`${baseName(props.path)} ${editing ? "编辑器" : "代码查看器"}`}
        value={props.value}
        readOnly={!editing || props.readOnly}
        wrap={wrap ? "soft" : "off"}
        spellCheck={false}
        onChange={(event) => props.onChange(event.target.value)}
        onScroll={(event) => {
          scrollPositionRef.current = captureFileScrollPosition(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "s") {
            event.preventDefault();
            props.onSave();
          }
        }}
        className="cm-mobile-code-editor-text min-h-0 w-full min-w-0 flex-1 resize-none border-0 bg-[var(--cm-surface-panel)] p-3 font-mono text-[13px] leading-5 text-zinc-200 outline-none"
      />
    </div>
  );
}

function RevealTreeButton({
  onClick,
  className = "cm-icon-button absolute right-2 top-2",
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      title="显示目录树"
      aria-label="显示目录树"
      className={className}
      onClick={onClick}
    >
      <PanelRightOpen size={14} />
    </button>
  );
}

export function PathCrumbs({
  path,
  className = "",
  onOpenDirectory,
  disabled = false,
}: {
  path: string;
  className?: string;
  onOpenDirectory?: (path: string) => void;
  disabled?: boolean;
}) {
  const crumbs = breadcrumbs(path);
  const openDirectory = (directoryPath: string) => {
    if (!disabled) onOpenDirectory?.(directoryPath);
  };
  const directoryButton = (name: string, directoryPath: string) => (
    <button
      type="button"
      aria-label={`打开目录 ${directoryPath}`}
      title={`双击打开目录：${directoryPath}`}
      disabled={disabled}
      className="cursor-pointer border-0 bg-transparent p-0 text-inherit hover:text-zinc-300 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-zinc-500 disabled:cursor-default disabled:hover:text-inherit"
      onClick={(event) => {
        // 键盘和辅助技术触发的 click 没有鼠标点击计数；真实单击继续只负责聚焦。
        if (event.detail === 0) openDirectory(directoryPath);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        openDirectory(directoryPath);
      }}
    >
      {name}
    </button>
  );
  return (
    <span className={`truncate text-zinc-500 ${className}`} title={path}>
      {onOpenDirectory ? directoryButton("/", "/") : "/"}
      {crumbs.map((crumb, index) => {
        const directory = index < crumbs.length - 1;
        return (
          <span key={crumb.path}>
            {index > 0 && <span aria-hidden="true">/</span>}
            {directory && onOpenDirectory ? directoryButton(crumb.name, crumb.path) : crumb.name}
          </span>
        );
      })}
    </span>
  );
}

/**
 * input 的原生双击会先选中指针下的单词；selectionStart 因而落在对应路径段内。
 * 返回该段截止位置的绝对路径，让目录框保留直接编辑能力的同时支持双击父级。
 */
export function directoryPathAtSelection(
  path: string,
  selectionStart: number | null,
): string | null {
  if (!path.startsWith("/") || selectionStart === null) return null;
  if (path === "/" || selectionStart <= 0) return "/";
  const offset = Math.min(selectionStart, path.length - 1);
  const separator = path.indexOf("/", offset);
  const selectedPath = separator < 0 ? path : path.slice(0, separator);
  return normalizePath(selectedPath);
}

function ToolButton(props: {
  children: React.ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  onDisabledClick?: () => void;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (props.disabled) {
          props.onDisabledClick?.();
          return;
        }
        props.onClick();
      }}
      aria-disabled={props.disabled || undefined}
      aria-label={props.title}
      title={props.disabled ? props.disabledReason : props.title}
      className={`cm-button px-1.5 sm:px-2 ${props.disabled ? "opacity-50" : ""}`}
    >
      {props.children}
    </button>
  );
}
