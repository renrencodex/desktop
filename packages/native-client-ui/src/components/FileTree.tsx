/**
 * 文件树（15 节 tree）：根目录默认展开，子目录点击展开才 fs.list；目录优先排序、
 * 每行内联操作（重命名 / 删除 / 下载）。
 *
 * 已指定当前目录时，父组件已用 fs.resolve 验证过目录，这里直接以 rootPaths
 * 为树根，避免重复探测并把瞬时 RPC 错误误判为“根目录不可用”。只有未传
 * rootPaths 的通用模式才探测 agentd 默认沙箱根。
 *
 * 树状态（展开 / 子节点）分散在各 TreeDir 组件内；refreshSignal 变化时
 * 已展开的目录自动重载（新建 / 重命名 / 删除 / 上传后由父组件 bump）；
 * 可见时定期检查外部变更，保留展开状态及未变化的目录数据。
 */
import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FilePlus2,
  FolderInput,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";

import {
  DEFAULT_WORKSPACE_ROOT,
  LEGACY_WORKSPACE_PATH,
  type FsEntry,
} from "@cloud-machine/client-contracts";
import { hasLocalFileItems } from "@cloud-machine/workspace-ui/local-file-drop";
import type { WorkspaceGitDecoration } from "@cloud-machine/workspace-ui/workspace-diff-tree";

import { statFile } from "../lib/fs-client";
import { requestDirectoryListing } from "../lib/directory-listing";
import { breadcrumbs, sortEntries } from "../lib/fs-utils";
import type { MachineRpcClient } from "../lib/machine-rpc";
import { userErrorMessage } from "../lib/user-error";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** 未绑定开发目录时与 agentd 默认 AGENTD_FS_SANDBOX_ROOTS 对齐。 */
const DEFAULT_ROOTS = [DEFAULT_WORKSPACE_ROOT, "/home/developer", LEGACY_WORKSPACE_PATH];
const FILE_TREE_DRAG_TYPE = "application/x-cloud-machine-file-tree";
const GIT_DECORATIONS: Record<
  WorkspaceGitDecoration,
  { code: string; label: string; className: string }
> = {
  added: { code: "A", label: "新增", className: "text-emerald-400" },
  modified: { code: "M", label: "修改", className: "text-amber-400" },
  renamed: { code: "R", label: "重命名", className: "text-sky-400" },
  conflicted: { code: "!", label: "冲突", className: "text-red-400" },
};

interface FileTreeDragPayload {
  path: string;
  isDir: boolean;
}

export interface FileTreeProps {
  revealRequest?: { id: number; path: string } | null;
  onRevealed?: () => void;
  rpc: MachineRpcClient;
  rootPaths?: string[];
  /** 目录树当前是否可见；隐藏面板不轮询。 */
  active?: boolean;
  /** bump 触发已展开目录重载。 */
  refreshSignal: number;
  selectedPath: string | null;
  fileStatuses?: Record<string, { dirty: boolean; saving: boolean }>;
  gitDecorations?: Readonly<Record<string, WorkspaceGitDecoration>>;
  onOpenFile: (path: string) => void;
  onEnterDir: (dir: string) => void;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (path: string, isDir: boolean) => void;
  onDelete: (path: string, name: string, isDir: boolean) => void;
  onDownload: (path: string, kind: "file" | "directory") => void;
  onMove: (path: string, targetDir: string, isDir: boolean) => void;
  onMoveRequest: (path: string, isDir: boolean) => void;
  localDropDisabled?: boolean;
  onLocalDrop?: (targetDir: string, items: DataTransferItemList) => void;
}

export function FileTree(props: FileTreeProps) {
  const boundRoots = props.rootPaths ? [...new Set(props.rootPaths)] : null;
  const [discoveredRoots, setDiscoveredRoots] = useState<string[] | null>(null);
  const [localDropTarget, setLocalDropTarget] = useState<string | null>(null);

  useEffect(() => {
    if (props.rootPaths) return;
    let cancelled = false;
    void (async () => {
      const existing: string[] = [];
      for (const root of DEFAULT_ROOTS) {
        try {
          const st = await statFile(props.rpc, root);
          if (st.exists) existing.push(root);
        } catch {
          // 连接未就绪等：下一轮 refresh 再试
        }
      }
      if (!cancelled) setDiscoveredRoots(existing);
    })();
    return () => {
      cancelled = true;
    };
  }, [props.rpc, props.refreshSignal, props.rootPaths]);

  const roots = boundRoots ?? discoveredRoots;

  if (roots === null) {
    return null;
  }
  if (roots.length === 0) {
    return <div className="p-3 text-xs text-zinc-500">沙箱根目录均不可用</div>;
  }
  const localDropEnabled =
    roots.length === 1 && Boolean(props.onLocalDrop) && !props.localDropDisabled;
  const visibleLocalDropTarget = localDropEnabled ? localDropTarget : null;
  return (
    <div
      className="relative min-h-full py-1 text-sm"
      onDragOver={(event) => {
        if (!localDropEnabled || !hasLocalFileItems(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setLocalDropTarget(localDropDirectoryAt(event.target, event.currentTarget, roots[0]!));
      }}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        setLocalDropTarget(null);
      }}
      onDrop={(event) => {
        if (!localDropEnabled || !hasLocalFileItems(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        const target = localDropDirectoryAt(event.target, event.currentTarget, roots[0]!);
        setLocalDropTarget(null);
        props.onLocalDrop?.(target, event.dataTransfer.items);
      }}
    >
      {visibleLocalDropTarget && (
        <div
          role="status"
          className="pointer-events-none sticky top-1 z-10 h-0 px-1"
          title={visibleLocalDropTarget}
        >
          <div className="truncate rounded border px-2 py-1 text-[10px] cm-banner-warning">
            上传到 {visibleLocalDropTarget}
          </div>
        </div>
      )}
      {roots.map((root) => (
        <TreeDir
          key={root}
          rpc={props.rpc}
          path={root}
          name={root}
          depth={0}
          localDropTarget={visibleLocalDropTarget}
          ctx={props}
        />
      ))}
    </div>
  );
}

export function localDropDirectoryAt(
  target: EventTarget | null,
  container: HTMLElement,
  fallback: string,
): string {
  const element = target instanceof Element ? target : null;
  const row = element?.closest<HTMLElement>("[data-local-drop-directory]");
  return row && container.contains(row) ? (row.dataset.localDropDirectory ?? fallback) : fallback;
}

interface TreeDirProps {
  rpc: MachineRpcClient;
  path: string;
  name: string;
  depth: number;
  localDropTarget: string | null;
  ctx: FileTreeProps;
}

function TreeDir({ rpc, path, name, depth, localDropTarget, ctx }: TreeDirProps) {
  const selectedDescendantPath = ctx.selectedPath?.startsWith(`${path === "/" ? "" : path}/`)
    ? ctx.selectedPath
    : null;
  const [expansion, setExpansion] = useState(() => ({
    expanded: depth === 0 || selectedDescendantPath !== null,
    revealedSelectionPath: selectedDescendantPath,
  }));
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const gitDecoration = ctx.gitDecorations?.[path];
  const gitVisual = gitDecoration ? GIT_DECORATIONS[gitDecoration] : null;

  if (expansion.revealedSelectionPath !== selectedDescendantPath) {
    setExpansion({
      expanded: selectedDescendantPath ? true : expansion.expanded,
      revealedSelectionPath: selectedDescendantPath,
    });
  }
  const expanded = expansion.expanded;

  useEffect(() => {
    if (!expanded || ctx.active === false) return;
    let cancelled = false;
    let request: ReturnType<typeof requestDirectoryListing> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isVisible = () => document.visibilityState !== "hidden";
    const reload = () => {
      if (cancelled || !isVisible()) return;
      clearTimeout(timer);
      if (request) {
        request.refresh();
        return;
      }
      request = requestDirectoryListing(rpc, path, {
        isActive: () => !cancelled && isVisible(),
        complete: (result) => {
          request = undefined;
          if (cancelled) return;
          if (result.ok) {
            const next = sortEntries(result.entries);
            setEntries((previous) =>
              previous &&
              previous.length === next.length &&
              previous.every((entry, index) => {
                const other = next[index]!;
                return (
                  entry.name === other.name &&
                  entry.type === other.type &&
                  entry.size === other.size &&
                  entry.mtime === other.mtime
                );
              })
                ? previous
                : next,
            );
            setError(null);
          } else setError(userErrorMessage(result.error, "加载失败"));
          if (isVisible()) timer = setTimeout(reload, 2000);
        },
      });
    };
    const resume = () => {
      clearTimeout(timer);
      void reload();
    };
    void reload();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      cancelled = true;
      request?.cancel();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [rpc, path, expanded, ctx.refreshSignal, ctx.active]);

  const toggle = () => {
    setExpansion((current) => ({ ...current, expanded: !current.expanded }));
  };

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          data-local-drop-directory={path}
          data-git-descendant-status={gitDecoration}
          draggable={depth > 0}
          onDragStart={(event) => writeDragPayload(event, path, true)}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes(FILE_TREE_DRAG_TYPE)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            if (!event.dataTransfer.types.includes(FILE_TREE_DRAG_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
            setDragOver(false);
            const payload = readDragPayload(event);
            if (!payload || payload.path === path) return;
            if (payload.isDir && path.startsWith(`${payload.path}/`)) return;
            ctx.onMove(payload.path, path, payload.isDir);
          }}
          onClick={toggle}
          onDoubleClick={(event) => {
            event.preventDefault();
            ctx.onEnterDir(path);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggle();
          }}
          className={`cm-file-tree-item group flex cursor-pointer items-center gap-1 py-0.5 pr-1 text-zinc-300 hover:bg-zinc-800/60 ${
            dragOver || localDropTarget === path
              ? "bg-[var(--cm-accent-muted)] ring-1 ring-inset ring-[var(--cm-accent)]"
              : ""
          }`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          <span className="flex w-3 shrink-0 items-center justify-center text-zinc-500">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          {depth === 0 ? (
            <RootDirectoryPath
              path={path}
              gitDecoration={gitDecoration}
              onEnterDir={ctx.onEnterDir}
            />
          ) : (
            <span
              className={`min-w-0 flex-1 truncate ${gitVisual?.className ?? ""}`}
              title={gitVisual ? `${name} · 包含 Git 变动：${gitVisual.label}` : name}
            >
              {name}
            </span>
          )}
          <TreeItemMenu name={name} actions={directoryActions(path, name, depth > 0, ctx)} />
        </ContextMenuTrigger>
        <DirectoryContextMenu path={path} name={name} movable={depth > 0} ctx={ctx} />
      </ContextMenu>
      {expanded && error && (
        <div
          className="py-0.5 text-xs text-red-400"
          style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
        >
          {error}
        </div>
      )}
      {expanded &&
        entries?.map((entry) =>
          entry.type === "directory" ? (
            <TreeDir
              key={entry.name}
              rpc={rpc}
              path={`${path === "/" ? "" : path}/${entry.name}`}
              name={entry.name}
              depth={depth + 1}
              localDropTarget={localDropTarget}
              ctx={ctx}
            />
          ) : (
            <TreeFile
              key={entry.name}
              entry={entry}
              path={`${path === "/" ? "" : path}/${entry.name}`}
              depth={depth + 1}
              ctx={ctx}
            />
          ),
        )}
    </div>
  );
}

/** 根行显示完整路径，每段进入对应目录；子目录行仍保留原来的展开/进入行为。 */
function RootDirectoryPath({
  path,
  gitDecoration,
  onEnterDir,
}: {
  path: string;
  gitDecoration?: WorkspaceGitDecoration;
  onEnterDir: (path: string) => void;
}) {
  const segments = [{ name: "/", path: "/" }, ...breadcrumbs(path)];
  const gitVisual = gitDecoration ? GIT_DECORATIONS[gitDecoration] : null;
  return (
    <span
      className={`min-w-0 flex-1 truncate select-none ${gitVisual?.className ?? ""}`}
      title={gitVisual ? `${path} · 包含 Git 变动：${gitVisual.label}` : path}
    >
      {segments.map((segment, index) => (
        <span key={segment.path}>
          {index > 1 && <span aria-hidden="true">/</span>}
          <button
            type="button"
            aria-label={`打开目录 ${segment.path}`}
            title={`双击打开目录：${segment.path}`}
            className="cursor-pointer border-0 bg-transparent p-0 text-inherit hover:text-zinc-100 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-zinc-500"
            onClick={(event) => {
              // 单击只聚焦，不折叠根行；键盘/辅助技术的 click 直接进入目录。
              event.stopPropagation();
              if (event.detail === 0) onEnterDir(segment.path);
            }}
            onDoubleClick={(event) => {
              event.preventDefault();
              // 不能冒泡到根行，否则会再次进入完整路径，覆盖本段的导航。
              event.stopPropagation();
              onEnterDir(segment.path);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
          >
            {segment.name}
          </button>
        </span>
      ))}
    </span>
  );
}

function TreeFile({
  entry,
  path,
  depth,
  ctx,
}: {
  entry: FsEntry;
  path: string;
  depth: number;
  ctx: FileTreeProps;
}) {
  const selected = ctx.selectedPath === path;
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ctx.active === false || ctx.revealRequest?.path !== path || !rowRef.current) return;
    rowRef.current.scrollIntoView?.({ block: "nearest" });
    ctx.onRevealed?.();
  }, [ctx, path]);
  const status = ctx.fileStatuses?.[path];
  const gitDecoration = ctx.gitDecorations?.[path];
  const gitVisual = gitDecoration ? GIT_DECORATIONS[gitDecoration] : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        ref={rowRef}
        role="button"
        tabIndex={0}
        draggable
        onDragStart={(event) => writeDragPayload(event, path, false)}
        onClick={() => ctx.onOpenFile(path)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          ctx.onOpenFile(path);
        }}
        data-git-status={gitDecoration}
        className={`cm-file-tree-item group flex cursor-pointer items-center gap-1 py-0.5 pr-1 hover:bg-zinc-800/60 ${
          selected ? "bg-zinc-800 text-zinc-100" : "text-zinc-400"
        }`}
        style={{ paddingLeft: `${depth * 14 + 8 + 12}px` }}
      >
        <span
          className={`min-w-0 flex-1 truncate ${gitVisual?.className ?? ""}`}
          title={gitVisual ? `${entry.name} · Git：${gitVisual.label}` : entry.name}
        >
          {entry.name}
        </span>
        {gitVisual && (
          <span
            className={`w-3 shrink-0 text-center font-mono text-[10px] font-medium ${gitVisual.className}`}
            title={`Git：${gitVisual.label}`}
            aria-label={`Git：${gitVisual.label}`}
          >
            {gitVisual.code}
          </span>
        )}
        {status?.dirty && (
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              status.saving ? "animate-pulse bg-sky-400" : "bg-amber-400"
            }`}
            title={status.saving ? "保存中" : "未保存"}
          />
        )}
        <TreeItemMenu name={entry.name} actions={fileActions(path, entry.name, ctx)} />
      </ContextMenuTrigger>
      <FileContextMenu path={path} name={entry.name} ctx={ctx} />
    </ContextMenu>
  );
}

function writeDragPayload(event: React.DragEvent<HTMLElement>, path: string, isDir: boolean): void {
  event.stopPropagation();
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(FILE_TREE_DRAG_TYPE, JSON.stringify({ path, isDir }));
}

function readDragPayload(event: React.DragEvent<HTMLElement>): FileTreeDragPayload | null {
  try {
    const value = JSON.parse(
      event.dataTransfer.getData(FILE_TREE_DRAG_TYPE),
    ) as Partial<FileTreeDragPayload>;
    return typeof value.path === "string" && typeof value.isDir === "boolean"
      ? { path: value.path, isDir: value.isDir }
      : null;
  } catch {
    return null;
  }
}

function copyPath(path: string): void {
  void navigator.clipboard?.writeText(path);
}

type TreeAction = {
  key: string;
  label: string;
  icon: React.ReactNode;
  destructive?: boolean;
  onSelect: () => void;
};

function directoryActions(
  path: string,
  name: string,
  movable: boolean,
  ctx: FileTreeProps,
): Array<TreeAction | "separator"> {
  const actions: Array<TreeAction | "separator"> = [
    {
      key: "open-directory",
      label: "进入目录",
      icon: <FolderOpen size={13} />,
      onSelect: () => ctx.onEnterDir(path),
    },
    {
      key: "download-directory",
      label: "下载目录",
      icon: <Download size={13} />,
      onSelect: () => ctx.onDownload(path, "directory"),
    },
    {
      key: "new-file",
      label: "新建文件",
      icon: <FilePlus2 size={13} />,
      onSelect: () => ctx.onNewFile(path),
    },
    {
      key: "new-folder",
      label: "新建文件夹",
      icon: <FolderPlus size={13} />,
      onSelect: () => ctx.onNewFolder(path),
    },
    "separator",
  ];
  if (movable)
    actions.push({
      key: "rename",
      label: "重命名",
      icon: <Pencil size={13} />,
      onSelect: () => ctx.onRename(path, true),
    });
  actions.push({
    key: "copy-path",
    label: "复制路径",
    icon: <Copy size={13} />,
    onSelect: () => copyPath(path),
  });
  if (movable)
    actions.push({
      key: "move",
      label: "移动到…",
      icon: <FolderInput size={13} />,
      onSelect: () => ctx.onMoveRequest(path, true),
    });
  if (movable)
    actions.push("separator", {
      key: "delete",
      label: "删除",
      icon: <Trash2 size={13} />,
      destructive: true,
      onSelect: () => ctx.onDelete(path, name, true),
    });
  return actions;
}

function fileActions(
  path: string,
  name: string,
  ctx: FileTreeProps,
): Array<TreeAction | "separator"> {
  return [
    {
      key: "open",
      label: "打开",
      icon: <FilePlus2 size={13} />,
      onSelect: () => ctx.onOpenFile(path),
    },
    {
      key: "download",
      label: "下载",
      icon: <Download size={13} />,
      onSelect: () => ctx.onDownload(path, "file"),
    },
    "separator",
    {
      key: "rename",
      label: "重命名",
      icon: <Pencil size={13} />,
      onSelect: () => ctx.onRename(path, false),
    },
    {
      key: "copy-path",
      label: "复制路径",
      icon: <Copy size={13} />,
      onSelect: () => copyPath(path),
    },
    {
      key: "move",
      label: "移动到…",
      icon: <FolderInput size={13} />,
      onSelect: () => ctx.onMoveRequest(path, false),
    },
    "separator",
    {
      key: "delete",
      label: "删除",
      icon: <Trash2 size={13} />,
      destructive: true,
      onSelect: () => ctx.onDelete(path, name, false),
    },
  ];
}

function ContextActionItems({ actions }: { actions: Array<TreeAction | "separator"> }) {
  return actions.map((action, index) =>
    action === "separator" ? (
      <ContextMenuSeparator key={`separator-${index}`} />
    ) : (
      <ContextMenuItem key={action.key} destructive={action.destructive} onClick={action.onSelect}>
        {action.icon} {action.label}
      </ContextMenuItem>
    ),
  );
}

/**
 * 触屏没有 contextmenu（iOS 长按不触发），树项提供 ⋯ 按钮走 DropdownMenu；
 * 桌面端在行悬停、聚焦或菜单打开时显示，两份菜单共用动作定义。
 * 按钮始终保留布局尺寸：移入 Portal 菜单后行会失去 hover，不能隐藏定位锚点。
 * Portal 事件仍沿 React 树冒泡，菜单需隔离行上的打开文件、展开目录等操作。
 */
function TreeItemMenu({
  name,
  actions,
}: {
  name: string;
  actions: Array<TreeAction | "separator">;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`${name} 的更多操作`}
            className="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 opacity-0 hover:bg-zinc-700 hover:text-zinc-100 group-hover:opacity-100 group-focus-within:opacity-100 data-popup-open:opacity-100 [@media(pointer:coarse)]:h-8 [@media(pointer:coarse)]:w-8 [@media(pointer:coarse)]:opacity-100"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          />
        }
      >
        <MoreHorizontal size={13} />
      </DropdownMenuTrigger>
      {/* 目录树固定贴在工作区右侧；菜单从按钮左边展开，避免盖住下方子项。 */}
      <DropdownMenuContent
        side="left"
        align="start"
        sideOffset={4}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {actions.map((action, index) =>
          action === "separator" ? (
            <div key={`separator-${index}`} className="my-1 border-t border-zinc-800" />
          ) : (
            <DropdownMenuItem
              key={action.key}
              variant={action.destructive ? "destructive" : "default"}
              onClick={action.onSelect}
            >
              {action.icon} {action.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DirectoryContextMenu({
  path,
  name,
  movable,
  ctx,
}: {
  path: string;
  name: string;
  movable: boolean;
  ctx: FileTreeProps;
}) {
  return (
    <ContextMenuContent>
      <ContextActionItems actions={directoryActions(path, name, movable, ctx)} />
    </ContextMenuContent>
  );
}

function FileContextMenu({ path, name, ctx }: { path: string; name: string; ctx: FileTreeProps }) {
  return (
    <ContextMenuContent>
      <ContextActionItems actions={fileActions(path, name, ctx)} />
    </ContextMenuContent>
  );
}
